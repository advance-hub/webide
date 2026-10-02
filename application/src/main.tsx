import { ConfigProvider } from '@arco-design/web-react';
import zhCN from '@arco-design/web-react/es/locale/zh-CN';
import { createRoot } from 'react-dom/client';

import '@arco-design/web-react/dist/css/arco.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/workbench.css';
import { App } from './app';

createRoot(document.getElementById('root')!).render(
  <ConfigProvider locale={zhCN} componentConfig={{ Table: { border: false }, Input: { allowClear: true } }}>
    <App />
  </ConfigProvider>,
);
