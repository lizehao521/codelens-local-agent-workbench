import { expect, test } from '@playwright/test';

/**
 * 浏览器级 e2e：只验证不需要上游 Key 的交互。
 * - 输入框空闲推荐 -> Tab 只填草稿，不发请求
 * - 插件安装 -> 右栏常驻 -> 刷新后仍在
 */

test('输入框空闲推荐：Tab 只填草稿，不发送', async ({ page }) => {
  let agentRequested = false;
  page.on('request', (request) => {
    if (request.url().includes('/api/v1/agent/stream')) agentRequested = true;
  });

  await page.goto('/');
  const textarea = page.getByLabel('任务输入');
  await expect(textarea).toBeVisible();
  const hint = page.getByRole('button', { name: /下一步：/ });
  await expect(hint).toBeVisible();

  await textarea.focus();
  await textarea.press('Tab');
  await expect(textarea).toHaveValue(/data 目录/);
  expect(agentRequested, 'Tab 填草稿不应触发 Agent 请求').toBe(false);
});

test('插件安装后常驻右栏，刷新仍可见', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '设置' }).first().click();
  await page.getByRole('button', { name: 'UI 插件' }).click();

  await page.locator('#plugin-name').fill('E2E 插件');
  await page.locator('#plugin-desc').fill('Playwright 安装闭环');
  await page.locator('#plugin-items').fill('测试动作 | 帮我检查这次改动');
  await page.getByRole('button', { name: '安装插件' }).click();
  await expect(page.getByText('已安装，右栏「插件」页签可常驻使用。')).toBeVisible();

  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: '插件' }).click();
  await expect(page.getByText('E2E 插件')).toBeVisible();
  await page.getByRole('button', { name: '测试动作' }).click();
  await expect(page.getByLabel('任务输入')).toHaveValue('帮我检查这次改动');

  await page.reload();
  await page.getByRole('tab', { name: '插件' }).click();
  await expect(page.getByText('E2E 插件')).toBeVisible();
});
