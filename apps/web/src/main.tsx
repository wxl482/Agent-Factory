import { createRoot } from 'react-dom/client';
import { App as AntApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { App } from './App';
import { connect } from './lib/api';
import { darkTheme, UiBridge } from './lib/ui';
import './styles.css';

connect();
try {
  if ('Notification' in window && Notification.permission === 'default') {
    document.addEventListener('click', () => Notification.requestPermission(), { once: true });
  }
} catch {}

createRoot(document.getElementById('root')!).render(
  // 所有弹窗默认垂直居中（含 modal.confirm）
  <ConfigProvider theme={darkTheme} locale={zhCN} button={{ autoInsertSpace: false }} modal={{ centered: true }}>
    <AntApp className="ant-root" notification={{ top: 64 }}>
      <UiBridge />
      <App />
    </AntApp>
  </ConfigProvider>,
);
