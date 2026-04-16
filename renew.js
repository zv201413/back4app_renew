const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ACC = process.env.ACC || process.env.EML;
const ACC_PWD = process.env.ACC_PWD || process.env.PWD;
const TG_TOKEN = process.env.TG_TOKEN;
const TG_ID = process.env.TG_ID;
const PROXY_URL = process.env.PROXY_URL;
const APP_NAME = process.env.APP_NAME || 'b4app';

const LOGIN_URL = 'https://www.back4app.com/login';

async function sendTG(statusIcon, statusText, extra, imagePath) {
  if (!TG_TOKEN || !TG_ID) return;
  extra = extra || '';
  try {
    var time = new Date(Date.now() + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
    var text = 'Back4app 自动部署提醒\n' + statusIcon + ' ' + statusText + '\n' + extra + '\n账号: ' + ACC + '\n时间: ' + time;
    if (imagePath && fs.existsSync(imagePath)) {
      var fileData = fs.readFileSync(imagePath);
      var fd = new FormData();
      fd.append('chat_id', TG_ID);
      fd.append('caption', text);
      fd.append('photo', new Blob([fileData], { type: 'image/png' }), path.basename(imagePath));
      var res = await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendPhoto', { method: 'POST', body: fd });
      if (res.ok) console.log('✅ TG 通知已发送');
      else console.log('⚠️ TG 发送失败:', res.status, await res.text());
    } else {
      var res2 = await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: TG_ID, text: text })
      });
      if (res2.ok) console.log('✅ TG 通知已发送');
      else console.log('⚠️ TG 发送失败:', res2.status, await res2.text());
    }
  } catch (e) { console.log('⚠️ TG 发送失败:', e.message); }
}

function addToSummary(title, imagePath) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  try {
    let summary = `### ${title}\n\n`;
    if (imagePath && fs.existsSync(imagePath)) {
      const b64 = fs.readFileSync(imagePath, { encoding: 'base64' });
      summary += `![${title}](data:image/png;base64,${b64})\n\n`;
    }
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  } catch (e) {
    console.log('⚠️ 写入 GitHub Summary 失败:', e.message);
  }
}

async function retry(page, fn, name, maxRetries = 3) {
  for (let i = 1; i <= maxRetries; i++) {
    try {
      await fn();
      return true;
    } catch (e) {
      console.log(`⚠️ ${name} 失败 (${i}/${maxRetries}): ${e.message}`);
      if (i < maxRetries) {
        await page.waitForTimeout(2000);
      }
    }
  }
  throw new Error(`${name} 重试 ${maxRetries} 次后失败`);
}

(async function main() {
  console.log('==================================================');
  console.log('Back4app 自动重新部署');
  console.log('==================================================');
  if (!ACC || !ACC_PWD) { console.log('❌ 未找到账号或密码'); process.exit(1); }

  var launchOpts = { headless: true, channel: 'chrome' };
  if (PROXY_URL) launchOpts.proxy = { server: 'http://127.0.0.1:8080' };
  
  var browser = await chromium.launch(launchOpts);
  var context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  var page = await context.newPage();

  try {
    console.log('🌐 打开登录页');
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('input[name="email"]', { timeout: 30000 });
    await page.screenshot({ path: 'step1_login_page.png' });
    addToSummary('Step 1: 登录页', 'step1_login_page.png');

    console.log('📧 填写邮箱密码');
    await page.locator('input[name="email"], input[id="email"]').fill(ACC);
    await page.locator('input[name="password"], input[id="password"]').fill(ACC_PWD);
    await page.screenshot({ path: 'step2_filled.png' });
    addToSummary('Step 2: 填写信息', 'step2_filled.png');

    console.log('🖱️ 点击 Continue');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    
    console.log('⏳ 等待控制台加载...');
    await page.waitForURL('**/dashboard**', { timeout: 60000 });
    await page.waitForLoadState('load');
    await page.screenshot({ path: 'step3_dashboard.png' });
    addToSummary('Step 3: 登录成功 - 控制台', 'step3_dashboard.png');

    console.log('⏳ 等待 5 秒...');
    await page.waitForTimeout(5000);

    console.log('🖱️ 点击 Web Deployment 选项卡');
    await retry(page, async () => {
      const webDeploymentTab = page.locator('a:has-text("Web Deployment"), button:has-text("Web Deployment")').filter({ visible: true }).first();
      await webDeploymentTab.waitFor({ state: 'visible', timeout: 30000 });
      await webDeploymentTab.click();
    }, '点击 Web Deployment');
    await page.screenshot({ path: 'step3.5_web_deployment.png' });
    addToSummary('Step 3.5: 切换到 Web Deployment', 'step3.5_web_deployment.png');

    console.log(`🖱️ 选择应用 "${APP_NAME}"`);
    await retry(page, async () => {
      const loading = page.locator('text=Loading...');
      if (await loading.isVisible()) {
          console.log('⏳ 正在加载列表，等待中...');
          await loading.waitFor({ state: 'hidden', timeout: 30000 });
      }
      const appLink = page.locator(`a:has-text("${APP_NAME}"), div:has-text("${APP_NAME}")`).filter({ visible: true }).first();
      await appLink.waitFor({ state: 'visible', timeout: 30000 });
      await appLink.click();
    }, `选择应用 ${APP_NAME}`);

    console.log('⏳ 等待应用详情页加载...');
    await page.waitForLoadState('load');
    await page.screenshot({ path: 'step4_app_detail.png' });
    addToSummary('Step 4: 应用详情页', 'step4_app_detail.png');

    console.log('🚀 点击 "Redeploy App"');
    await retry(page, async () => {
      const redeployBtn = page.locator('button:has-text("Redeploy App"), a:has-text("Redeploy App")').first();
      await redeployBtn.waitFor({ state: 'visible', timeout: 30000 });
      await redeployBtn.click();
    }, '点击 Redeploy App');

    console.log('⏳ 等待部署开始...');
    await page.waitForTimeout(3000); 
    await page.screenshot({ path: 'step5_redeploying.png' });
    addToSummary('Step 5: 开始重新部署', 'step5_redeploying.png');

    console.log('✅ 操作完成');
    await sendTG('✅', 'Back4app 重新部署成功', '已点击 Redeploy App', 'step5_redeploying.png');

  } catch (error) {
    console.log('❌ 流程失败: ' + error.message);
    await page.screenshot({ path: 'failure.png' });
    addToSummary('❌ 流程失败', 'failure.png');
    await sendTG('❌', 'Back4app 部署失败', error.message, 'failure.png');
  } finally {
    await context.close();
    await browser.close();
  }
})();
