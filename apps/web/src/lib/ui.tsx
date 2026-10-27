import { App as AntApp, theme, type ThemeConfig } from 'antd';
import type { MessageInstance } from 'antd/es/message/interface';
import type { HookAPI as ModalHookAPI } from 'antd/es/modal/useModal';

/** 统一组件库：Ant Design。主界面用暗色主题，3D 办公室上的悬浮控件用亮色主题 */

const font = `-apple-system, 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', 'Segoe UI', sans-serif`;

export const darkTheme: ThemeConfig = {
  algorithm: theme.darkAlgorithm,
  token: {
    colorPrimary: '#f59e0b',
    colorSuccess: '#10b981',
    colorError: '#ef4444',
    colorWarning: '#f59e0b',
    colorInfo: '#60a5fa',
    colorBgBase: '#0f1218',
    colorBgContainer: '#161a22',
    colorBgElevated: '#1d222c',
    colorBorder: '#2a303c',
    colorBorderSecondary: '#232935',
    colorText: '#e6e9ef',
    colorTextSecondary: '#8b93a3',
    borderRadius: 8,
    fontFamily: font,
    fontSize: 13,
  },
  components: {
    Button: { primaryColor: '#1a1300', fontWeight: 600 },
    Segmented: { itemSelectedBg: '#2b3240', trackBg: '#0f1218' },
    Tabs: { itemSelectedColor: '#e6e9ef', inkBarColor: '#f59e0b', titleFontSize: 13 },
    Modal: { contentBg: '#161a22', headerBg: '#161a22' },
  },
};

export const lightTheme: ThemeConfig = {
  algorithm: theme.defaultAlgorithm,
  token: {
    colorPrimary: '#1f2937',
    colorBgBase: '#ffffff',
    colorBgContainer: '#ffffff',
    colorBgElevated: '#ffffff',
    colorText: '#1f2937',
    colorTextSecondary: '#4b5563',
    colorBorder: '#d1d5db',
    colorBorderSecondary: '#e5e7eb',
    borderRadius: 8,
    fontFamily: font,
    fontSize: 13,
  },
  components: {
    // 嵌套主题会继承外层的 token/组件配置：必须显式覆盖文字色与 hover 色，避免继承外层暗色主题的浅色字（#e6e9ef）导致白底白字
    Button: { primaryColor: '#ffffff', fontWeight: 600 },
    Segmented: {
      itemColor: '#4b5563',
      itemHoverColor: '#111827',
      itemHoverBg: 'rgba(15, 23, 42, 0.08)',
      itemSelectedBg: '#1f2937',
      itemSelectedColor: '#ffffff',
      trackBg: 'rgba(255,255,255,0.92)',
    },
  },
};

/** 让非组件代码（如 api.ts）也能弹出提示和确认框 */
export let toast: MessageInstance | null = null;
export let modal: ModalHookAPI | null = null;

export function UiBridge() {
  const app = AntApp.useApp();
  toast = app.message;
  modal = app.modal;
  return null;
}

/** 确认框（替代浏览器原生 confirm） */
export function confirmAction(title: string, content?: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (!modal) return resolve(window.confirm(title));
    modal.confirm({ centered: true, title, content, okText: '确定', cancelText: '取消', onOk: () => resolve(true), onCancel: () => resolve(false) });
  });
}
