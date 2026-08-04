import { log, logError } from "../utils/logger";
import { runAppleScript } from "../utils/appleScript";
import { isWindows } from "../utils/windowsShell";

/**
 * 音量守卫：录制期间静音系统 + 暂停 Chrome 媒体，空闲时恢复。
 *
 * 相比旧实现的关键改进：
 * - Chrome 暂停脚本与系统静音并行执行（原为串行，Chrome AppleScript 慢，
 *   并行可显著缩短进入录制状态的时间）。
 * - 内部状态（isSystemMutedByApp / pausedChromeTabs / activeMutePromise）全部封装，
 *   不再散落于 index.ts 全局变量。
 * - 并发去重：重复调用 mute 只会触发一次，unmute/restore 会等待进行中的 mute 完成。
 */
export class VolumeGuard {
  private isSystemMutedByApp = false;
  private pausedChromeTabs: string[] = [];
  private activeMutePromise: Promise<void> | null = null;

  async muteSystemAndPauseMedia(): Promise<void> {
    // Windows：无 AppleScript Chrome 暂停与系统静音等价物，静默跳过
    if (isWindows()) {
      log("VolumeControl: skipping system mute (Windows has no equivalent)");
      return;
    }
    if (this.activeMutePromise) {
      return this.activeMutePromise;
    }

    const muteAction = async () => {
      log("VolumeControl: muting system and pausing Chrome media...");
      const pauseChrome = this.pauseChromeTabs();
      const muteSystem = this.muteSystem();
      await Promise.all([pauseChrome, muteSystem]);
      log("VolumeControl: mute complete");
    };

    this.activeMutePromise = muteAction().finally(() => {
      this.activeMutePromise = null;
    });

    return this.activeMutePromise;
  }

  private async pauseChromeTabs(): Promise<void> {
    try {
      const script = `tell application "Google Chrome"
      set pausedTabs to {}
      if it is running then
          repeat with w in windows
              repeat with t in tabs of w
                  try
                      set isPlaying to execute t javascript "(function() {
                          var played = false;
                          function scan(root) {
                              if (!root) return;
                              var v = root.querySelectorAll('video, audio');
                              for (var i = 0; i < v.length; i++) {
                                  if (!v[i].paused && v[i].muted === false && (typeof v[i].volume !== 'number' || v[i].volume > 0)) {
                                      v[i].setAttribute('data-diri-paused', 'true');
                                      v[i].pause();
                                      played = true;
                                  }
                              }
                              root.querySelectorAll('*').forEach(function(el) {
                                  if (el.shadowRoot) scan(el.shadowRoot);
                              });
                              root.querySelectorAll('iframe').forEach(function(f) {
                                  try { if (f.contentDocument) scan(f.contentDocument); } catch(e) {}
                              });
                          }
                          scan(document);
                          return played;
                      })()"
                      if isPlaying is true then
                          set end of pausedTabs to (id of t as string)
                      end if
                  end try
              end repeat
          end repeat
      end if
      return pausedTabs
  end tell`;

      const stdout = await runAppleScript(script);
      const trimmed = stdout.trim();
      if (trimmed) {
        const newPaused = trimmed.split(",").map((id) => id.trim());
        for (const id of newPaused) {
          if (!this.pausedChromeTabs.includes(id)) {
            this.pausedChromeTabs.push(id);
          }
        }
        log(`VolumeControl: Paused Chrome tabs (accumulated): ${this.pausedChromeTabs.join(", ")}`);
      }
    } catch (err) {
      logError("VolumeControl: Chrome pause failed", err);
    }
  }

  private async muteSystem(): Promise<void> {
    try {
      await runAppleScript("set volume with output muted");
      this.isSystemMutedByApp = true;
      log("VolumeControl: Muted system output");
    } catch (err) {
      logError("VolumeControl: Mute failed", err);
    }
  }

  async unmuteSystemOnly(): Promise<void> {
    if (isWindows()) return;
    if (this.activeMutePromise) {
      log("VolumeControl: waiting for active mute operation to complete first...");
      await this.activeMutePromise;
    }

    if (this.isSystemMutedByApp) {
      try {
        await runAppleScript("set volume without output muted");
        this.isSystemMutedByApp = false;
        log("VolumeControl: Unmuted system output");
      } catch (err) {
        logError("VolumeControl: Unmute failed", err);
      }
    }
  }

  async restoreMediaOnly(): Promise<void> {
    if (isWindows()) return;
    if (this.activeMutePromise) {
      log("VolumeControl: waiting for active mute operation to complete first...");
      await this.activeMutePromise;
    }

    if (this.pausedChromeTabs.length > 0) {
      try {
        const idsString = this.pausedChromeTabs.map((id) => `"${id}"`).join(", ");
        const script = `tell application "Google Chrome"
    if it is running then
        repeat with w in windows
            repeat with t in tabs of w
                if (id of t as string) is in {${idsString}} then
                    try
                        execute t javascript "(function() {
                            var found = false;
                            function scan(root) {
                                if (!root) return;
                                var v = root.querySelectorAll('video[data-diri-paused=true], audio[data-diri-paused=true]');
                                for (var i = 0; i < v.length; i++) {
                                    v[i].play();
                                    v[i].removeAttribute('data-diri-paused');
                                    found = true;
                                }
                                root.querySelectorAll('*').forEach(function(el) {
                                    if (el.shadowRoot) scan(el.shadowRoot);
                                });
                                root.querySelectorAll('iframe').forEach(function(f) {
                                    try { if (f.contentDocument) scan(f.contentDocument); } catch(e) {}
                                });
                            }
                            scan(document);
                            if (!found) {
                                function resumeFallback(root) {
                                    if (!root) return;
                                    var all = root.querySelectorAll('video, audio');
                                    for (var i = 0; i < all.length; i++) {
                                        if (all[i].paused && all[i].muted === false && (typeof all[i].volume !== 'number' || all[i].volume > 0)) {
                                            all[i].play();
                                        }
                                    }
                                    root.querySelectorAll('*').forEach(function(el) {
                                        if (el.shadowRoot) resumeFallback(el.shadowRoot);
                                    });
                                    root.querySelectorAll('iframe').forEach(function(f) {
                                        try { if (f.contentDocument) resumeFallback(f.contentDocument); } catch(e) {}
                                    });
                                }
                                resumeFallback(document);
                            }
                        })()"
                    end try
                end if
            end repeat
        end repeat
    end if
end tell`;
        await runAppleScript(script);
        log(`VolumeControl: Resumed Chrome tabs: ${this.pausedChromeTabs.join(", ")}`);
      } catch (err) {
        logError("VolumeControl: Chrome resume failed", err);
      }
      this.pausedChromeTabs = [];
    }
  }
}
