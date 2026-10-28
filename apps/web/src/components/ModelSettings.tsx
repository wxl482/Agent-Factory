import { useEffect, useMemo, useState } from 'react';
import { Alert, AutoComplete, Button, Input, InputNumber, Modal, Select } from 'antd';
import { ApiOutlined, CheckCircleFilled, CloseCircleFilled, ExperimentOutlined } from '@ant-design/icons';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { confirmAction, toast } from '../lib/ui';

/**
 * 模型设置：不用改 .env、不用重启，填好 Key 测试通过就立即切换。
 * Key 只上传不回显，界面只显示掩码。
 */

interface Preset {
  value: string;
  label: string;
  baseURL: string;
  /** 常用模型名，仅作输入建议；以「测试连接」拉到的列表为准 */
  models: string[];
  keyUrl?: string;
}

const PRESETS: Preset[] = [
  { value: 'deepseek', label: 'DeepSeek', baseURL: 'https://api.deepseek.com', models: ['deepseek-chat', 'deepseek-reasoner'], keyUrl: 'https://platform.deepseek.com/api_keys' },
  { value: 'qwen', label: '通义千问（阿里云百炼）', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-plus', 'qwen-max', 'qwen-turbo'], keyUrl: 'https://bailian.console.aliyun.com/' },
  { value: 'kimi', label: 'Kimi（月之暗面）', baseURL: 'https://api.moonshot.cn/v1', models: [], keyUrl: 'https://platform.moonshot.cn/console/api-keys' },
  { value: 'zhipu', label: '智谱 GLM', baseURL: 'https://open.bigmodel.cn/api/paas/v4', models: [], keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys' },
  { value: 'doubao', label: '豆包（火山方舟）', baseURL: 'https://ark.cn-beijing.volces.com/api/v3', models: [], keyUrl: 'https://console.volcengine.com/ark' },
  { value: 'openai', label: 'OpenAI', baseURL: 'https://api.openai.com/v1', models: [], keyUrl: 'https://platform.openai.com/api-keys' },
  { value: 'ollama', label: '本机 Ollama', baseURL: 'http://localhost:11434/v1', models: [] },
  { value: 'custom', label: '其他（OpenAI 兼容接口）', baseURL: '', models: [] },
];

const presetOf = (url?: string) => PRESETS.find((p) => p.baseURL && url?.replace(/\/+$/, '') === p.baseURL)?.value ?? (url ? 'custom' : 'deepseek');

export function ModelModal() {
  const show = useStore((s) => s.showModel);
  const close = () => useStore.setState({ showModel: false });
  return (
    <Modal open={show} onCancel={close} footer={null} width={560} title="模型设置" destroyOnHidden>
      <ModelForm onDone={close} />
    </Modal>
  );
}

type TestState = { state: 'idle' } | { state: 'testing' } | { state: 'ok'; models: string[] } | { state: 'fail'; error: string };

function ModelForm({ onDone }: { onDone: () => void }) {
  const llm = useStore((s) => s.llm);
  const pricing = useStore((s) => s.usage?.pricing);
  const demo = llm?.provider === 'mock';
  const [preset, setPreset] = useState(() => presetOf(demo && !llm?.keyHint ? undefined : llm?.baseURL));
  const [baseURL, setBaseURL] = useState(() => (demo && !llm?.keyHint ? PRESETS[0].baseURL : (llm?.baseURL ?? PRESETS[0].baseURL)));
  const [model, setModel] = useState(() => (demo ? '' : (llm?.model ?? '')));
  const [apiKey, setApiKey] = useState('');
  const [price, setPrice] = useState({ input: pricing?.input ?? 2, cacheHit: pricing?.cacheHit ?? 0.5, output: pricing?.output ?? 8 });
  const [test, setTest] = useState<TestState>({ state: 'idle' });
  const [saving, setSaving] = useState(false);

  const p = PRESETS.find((x) => x.value === preset)!;
  const canUseSavedKey = !!llm?.keyHint;
  const ready = !!baseURL.trim() && !!model.trim() && (!!apiKey.trim() || canUseSavedKey);
  const modelOptions = useMemo(() => {
    const fromTest = test.state === 'ok' ? test.models : [];
    return [...new Set([...fromTest, ...p.models])].filter((m) => !model || m.toLowerCase().includes(model.toLowerCase())).slice(0, 50).map((m) => ({ value: m }));
  }, [test, p, model]);

  // 改了配置，之前的测试结果作废
  useEffect(() => setTest((t) => (t.state === 'testing' ? t : { state: 'idle' })), [baseURL, model, apiKey]);

  const form = () => ({ apiKey: apiKey.trim() || undefined, baseURL: baseURL.trim(), model: model.trim(), pricing: price });
  const runTest = async () => {
    setTest({ state: 'testing' });
    try {
      const r = await api<{ ok: boolean; error?: string; models: string[] }>('/api/llm/test', form());
      setTest(r.ok ? { state: 'ok', models: r.models } : { state: 'fail', error: r.error ?? '连接失败' });
    } catch (e: any) {
      setTest({ state: 'fail', error: e?.message ?? '连接失败' });
    }
  };
  const save = async () => {
    setSaving(true);
    try {
      await api('/api/llm', form());
      toast?.success(`已切换到 ${model}，员工下一步就会用上新模型`);
      onDone();
    } catch {
      // 错误提示由 api() 弹出；同时显示在测试结果里
      setTest({ state: 'idle' });
    } finally {
      setSaving(false);
    }
  };
  const toDemo = async () => {
    if (!(await confirmAction('切回演示模式？', '演示模式按剧本运行，不调用真实模型、不花钱。已保存的 Key 会保留，随时可以切回来。'))) return;
    await api('/api/llm/demo', {});
    toast?.success('已切回演示模式');
    onDone();
  };

  return (
    <div className="model-form">
      {demo ? (
        <Alert
          type="info"
          showIcon
          message="现在是演示模式"
          description="员工按预设剧本工作，不调用真实模型、不花钱，适合先熟悉操作。接入真实模型后，员工才会真正按你的目标思考和产出。"
        />
      ) : (
        <Alert type="success" showIcon message={`正在使用 ${llm?.model}`} description={`${llm?.baseURL ?? ''}${llm?.keyHint ? ` · Key ${llm.keyHint}` : ''}`} />
      )}

      <div className="rules-card">
        <div className="model-field">
          <label>服务商</label>
          <Select
            value={preset}
            options={PRESETS.map((x) => ({ value: x.value, label: x.label }))}
            onChange={(v) => {
              setPreset(v);
              const np = PRESETS.find((x) => x.value === v)!;
              if (np.baseURL) setBaseURL(np.baseURL);
            }}
          />
        </div>
        <div className="model-field">
          <label>
            API Key
            {p.keyUrl && (
              <a href={p.keyUrl} target="_blank" rel="noopener noreferrer">
                去获取
              </a>
            )}
          </label>
          <Input.Password
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={canUseSavedKey ? `已保存 ${llm?.keyHint}，不修改请留空` : p.value === 'ollama' ? 'Ollama 不需要 Key，随便填一个即可，例如 ollama' : 'sk-…'}
            autoComplete="off"
          />
        </div>
        <div className="model-field">
          <label>接口地址</label>
          <Input value={baseURL} onChange={(e) => setBaseURL(e.target.value)} placeholder="https://…/v1" />
        </div>
        <div className="model-field">
          <label>模型名{test.state === 'ok' && test.models.length > 0 && <span>可从 {test.models.length} 个可用模型里选</span>}</label>
          <AutoComplete value={model} onChange={setModel} options={modelOptions} placeholder="先测试连接可以拉取可用模型列表" />
        </div>
        <div className="model-field">
          <label>
            单价（每百万 token，用于成本统计）<span>以服务商官网价格为准</span>
          </label>
          <div className="model-prices">
            <InputNumber min={0} step={0.1} value={price.input} onChange={(v) => setPrice((x) => ({ ...x, input: v ?? 0 }))} addonBefore="输入" />
            <InputNumber min={0} step={0.1} value={price.cacheHit} onChange={(v) => setPrice((x) => ({ ...x, cacheHit: v ?? 0 }))} addonBefore="缓存" />
            <InputNumber min={0} step={0.1} value={price.output} onChange={(v) => setPrice((x) => ({ ...x, output: v ?? 0 }))} addonBefore="输出" />
          </div>
        </div>
      </div>

      {test.state === 'ok' && (
        <div className="model-test ok">
          <CheckCircleFilled /> 连接成功，可以保存
        </div>
      )}
      {test.state === 'fail' && (
        <div className="model-test fail">
          <CloseCircleFilled /> {test.error}
        </div>
      )}

      <div className="rules-actions">
        {!demo && (
          <Button type="text" icon={<ExperimentOutlined />} onClick={toDemo}>
            切回演示模式
          </Button>
        )}
        <span className="spacer" />
        <Button icon={<ApiOutlined />} disabled={!ready} loading={test.state === 'testing'} onClick={runTest}>
          测试连接
        </Button>
        <Button type="primary" disabled={!ready} loading={saving} onClick={save}>
          保存并切换
        </Button>
      </div>
    </div>
  );
}
