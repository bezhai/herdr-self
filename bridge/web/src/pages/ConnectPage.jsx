import { useEffect, useState } from 'react';
import { callApi } from '../api.js';
import { replace } from '../location.js';

const feishuHosts = ['open.feishu.cn', 'open.larkoffice.com', 'open.larksuite.com'];

// This page does not use request(): a 401 goes back to the console before the body is read,
// and every other failure shows one generic message.
async function call(path, body) {
  const response = await callApi(path, body);
  if (response.status === 401) {
    replace('/');
    throw new Error('请先登录');
  }
  if (!response.ok) throw new Error('暂时无法打开飞书');
  return response.json();
}

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Starts (or joins) a registration, polls once a second up to 40 times until it has a pending
// authorization URL, and replaces this page with it. Only https URLs on the Feishu hosts are followed.
async function openFeishu() {
  let registration = await call('/apps/registration/start', {});
  const { id } = registration;
  for (let i = 0; i < 40; i += 1) {
    if (registration.url && registration.status === 'pending') {
      const url = new URL(registration.url);
      if (url.protocol !== 'https:' || !feishuHosts.includes(url.hostname)) throw new Error('创建链接不可用');
      replace(url.href);
      return;
    }
    if (registration.id !== id || !['starting', 'pending'].includes(registration.status)) throw new Error('请返回管理台重试');
    await wait(1000);
    registration = (await call('/state')).registration || {};
  }
  throw new Error('连接超时，请重试');
}

export function ConnectPage() {
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState(null);

  useEffect(() => {
    let current = true;
    setError(null);
    openFeishu().catch((e) => { if (current) setError(e.message); });
    return () => { current = false; };
  }, [attempt]);

  return (
    <>
      <div className="pair" aria-hidden="true">
        <span className="logo">
          <svg viewBox="0 0 32 32">
            <rect width="32" height="32" fill="#d9dad8" />
            <path d="M10 8v16m0-8.5c1.6-2 3.4-3 5.5-3 3 0 4.5 1.9 4.5 5V24" fill="none" stroke="#303438" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <span className="wire-h" />
        <span className="feishu-mark">
          <svg viewBox="0 0 48 48">
            <path fill="#3370ff" d="M7 14 25 5l-6 16L7 28z" />
            <path fill="#00b8d9" d="m20 22 21-9-7 20-16 10z" />
            <path fill="#1456f0" d="m7 28 13-6 14 11-16 10z" />
          </svg>
        </span>
      </div>
      {!error && <span className="spinner" />}
      <h1>{error ? '未能打开飞书' : '正在打开飞书'}</h1>
      <p>{error || '请稍候'}</p>
      {error && <button type="button" className="primary" onClick={() => setAttempt((n) => n + 1)}>重试</button>}
      {error && <a href="/" className="text-button">返回管理台</a>}
    </>
  );
}
