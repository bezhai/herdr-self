import { useState } from 'react';
import { request } from '../api.js';
import { Icon } from '../components/Icon.jsx';
import { Brand, Logo } from '../components/Logo.jsx';

// onLogin: called after the session cookie is set; refreshes state, which opens the console.
export function LoginPage({ onLogin }) {
  const [key, setKey] = useState('');
  const [error, setError] = useState('');

  async function submit(event) {
    event.preventDefault();
    try {
      await request('/login', { key });
      setKey('');
      setError('');
      await onLogin();
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <section className="login">
      <div className="login-panel">
        <Brand />
        <div className="login-body">
          <p className="eyebrow">ADMIN CONSOLE</p>
          <h1>登录管理台</h1>
          <p className="muted">访问密钥保存在 Bridge 状态目录的 <code>access-key</code> 文件中。</p>
          <form id="login-form" onSubmit={submit}>
            <label htmlFor="key">访问密钥</label>
            <div className="input-icon">
              <Icon name="key" />
              <input id="key" type="password" autoComplete="current-password" required placeholder="粘贴访问密钥" value={key} onChange={(e) => setKey(e.target.value)} />
            </div>
            <button type="submit" className="primary">进入管理台</button>
            <p id="login-error" className="error" role="alert">{error}</p>
          </form>
        </div>
        <p className="login-foot">herdr-bridge 0.1.0</p>
      </div>
      <div className="login-visual" aria-hidden="true">
        <div className="route">
          <div className="node">
            <span className="node-tag"><Icon name="feishu" />飞书 · 群聊</span>
            <p className="bubble"><b>@Claude</b> 帮我看看 bridge 目录最近的改动</p>
          </div>
          <div className="wire"><i /></div>
          <div className="node">
            <span className="node-tag"><Logo tiny />herdr bridge</span>
            <p className="mono">oc_5d1e… <span>→</span> cpu2 / w1:p2</p>
          </div>
          <div className="wire"><i /></div>
          <div className="node focus">
            <span className="node-tag"><Icon name="terminal" />cpu2 · w1:p2</span>
            <p className="mono agent-line"><span className="pulse" />claude<em>working</em></p>
          </div>
        </div>
        <p className="tagline">熟悉的终端。<br />更多的连接方式。</p>
      </div>
    </section>
  );
}
