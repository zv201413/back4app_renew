const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ACC = process.env.ACC || process.env.EML;
const ACC_PWD = process.env.ACC_PWD || process.env.PWD;
const TG_TOKEN = process.env.TG_TOKEN;
const TG_ID = process.env.TG_ID;
const PROXY_URL = process.env.PROXY_URL;

const LOGIN_URL = 'https://www.back4app.com/';

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
    console.log('🌐 打开首页');
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle', timeout: 60000 });
    await page.screenshot({ path: 'step1_landing.png' });
    addToSummary('Step 1: 访问首页', 'step1_landing.png');

    console.log('🔘 检查弹窗');
    const understandBtn = page.locator('button:has-text("I understand"), button:has-text("I Understand")').first();
    if (await understandBtn.isVisible().catch(() => false)) {
        console.log('🔘 点击"我明白"');
        await understandBtn.click();
        await page.waitForTimeout(1000);
    }

    console.log('🖱️ 点击右上角 Log in');
    await page.locator('a:has-text("Log in"), a:has-text("Login")').first().click();
    await page.waitForURL('**/login**', { timeout: 30000 });
    
    await page.waitForSelector('input[type="email"], input[placeholder*="Email"]', { timeout: 30000 });
    await page.screenshot({ path: 'step2_login_page.png' });
    addToSummary('Step 2: 登录页面', 'step2_login_page.png');

    console.log('📧 填写账号密码');
    await page.locator('input[type="email"], input[placeholder*="Email"]').fill(ACC);
    await page.locator('input[type="password"], input[placeholder*="Password"]').fill(ACC_PWD);
    await page.screenshot({ path: 'step3_filled.png' });
    addToSummary('Step 3: 填写信息', 'step3_filled.png');

    console.log('🖱️ 提交登录');
    await page.getByRole('button', { name: 'Continue' }).click();
    
    console.log('⏳ 等待控制台加载...');
    await page.waitForURL('**/dashboard**', { timeout: 60000 });
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: 'step4_dashboard.png' });
    addToSummary('Step 4: 登录成功 - 控制台', 'step4_dashboard.png');

    console.log('⏳ 等待 5 秒...');
    await page.waitForTimeout(5000);

    console.log('🖱️ 选择应用 "b4app"');
    const appLink = page.locator('text=b4app').first();
    await appLink.waitFor({ state: 'visible', timeout: 30000 });
    await appLink.click();

    console.log('⏳ 等待应用详情页加载...');
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: 'step5_app_detail.png' });
    addToSummary('Step 5: 应用详情页', 'step5_app_detail.png');

    console.log('🚀 点击 "Redeploy App"');
    const redeployBtn = page.locator('button:has-text("Redeploy App"), a:has-text("Redeploy App")').first();
    await redeployBtn.waitFor({ state: 'visible', timeout: 30000 });
    await redeployBtn.click();

    console.log('⏳ 等待部署开始...');
    await page.waitForTimeout(3000); 
    await page.screenshot({ path: 'step6_redeploying.png' });
    addToSummary('Step 6: 开始重新部署', 'step6_redeploying.png');

    console.log('✅ 操作完成');
    await sendTG('✅', 'Back4app 重新部署成功', '已点击 Redeploy App', 'step6_redeploying.png');

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
