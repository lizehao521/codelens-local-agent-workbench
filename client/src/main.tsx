import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
// 字体走 JS 侧导入：@tailwindcss/vite 处理 CSS 里的 @import 时不会重写字体相对 url，
// 会留下 /node_modules/... 这类死链（静态服务回落成 index.html，字体解码失败）。
// 放到 JS 入口后由 Vite 正常改写为 /assets 下的 hash 资源。
import '@fontsource-variable/inter';
// 只装 400/500 两档：Noto Sans SC 的 woff2 按 unicode-range 切成数百个子集，
// 每多一档就多 ~5.6MB 产物（实测 3 档 16.76MB）。600 由浏览器对 500 合成加粗，
// 视觉差异仅在极端大字号下可辨，换来首屏少下载一半以上字体字节。
import '@fontsource/noto-sans-sc/400.css';
import '@fontsource/noto-sans-sc/500.css';
import '@fontsource-variable/jetbrains-mono';
import './styles/design-tokens.css';
import './styles/app.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('未找到 #root 挂载点');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
