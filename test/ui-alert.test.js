/**
 * test/ui-alert.test.js — 顶部提示条「文字 + ✕ 关闭」交互验收（DOM 桩 + 真实 panels 模块）
 *
 * 背景：真实页面里提示条用于展示连接异常/WebGL 回退等告警；必须可手动关闭，
 * 且在再次出现提示时能重新显示。此用例在 Node DOM 桩中真实执行 web/js/app.js + panels.js。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDomStub } from './web-dom-stub.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('顶部提示条：显示 → 点击 ✕ 关闭 → 再次提示重新显示 → 可清空', async () => {
  const stub = installDomStub();
  let app = null;
  try {
    await import('../web/js/app.js');
    app = globalThis.window.__RPS_APP__;
    assert.ok(app, 'app.js 应暴露 window.__RPS_APP__');
    for (let i = 0; i < 80 && !app.panels; i++) await sleep(50);
    const panels = app.panels;
    assert.ok(panels && panels.refs && panels.refs.alert, 'panels.refs.alert 应存在');

    const { bar, text, close } = panels.refs.alert;
    assert.equal(close.tagName, 'BUTTON', '关闭控件应为 button');
    assert.equal(close.id, 'alert-close');
    assert.equal(close.title, '关闭提示');
    assert.equal(close.getAttribute('aria-label'), '关闭提示');

    panels.setAlert('测试提示：连接异常');
    assert.ok(!bar.classList.contains('hidden'), 'setAlert 后提示条应显示');
    assert.ok(text.textContent.includes('测试提示'), '提示文字应写入');

    close.dispatch('click', { type: 'click' });
    assert.ok(bar.classList.contains('hidden'), '点击 ✕ 后提示条应隐藏');

    panels.setAlert('再次提示');
    assert.ok(!bar.classList.contains('hidden'), '再次 setAlert 应重新显示');
    assert.ok(text.textContent.includes('再次提示'));

    panels.setAlert(null);
    assert.ok(bar.classList.contains('hidden'), 'setAlert(null) 应隐藏提示条');

    assert.equal(stub.errors.length, 0, '运行期间不应有未捕获异常: ' + (stub.errors[0] && stub.errors[0].stack));
  } finally {
    if (app && app.shutdown) app.shutdown();
    stub.stop();
    await sleep(80);
  }
});
