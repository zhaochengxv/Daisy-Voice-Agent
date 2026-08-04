import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// 暴露平台给 CSS 适配：macOS 用隐藏标题栏（需拖拽区 + 顶部留白），Windows 用原生标题栏
const platform = window.diriAPI?.platform || "darwin";
document.documentElement.dataset.platform = platform;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
