const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ========== 环境变量 ==========
const TG_TOKEN = process.env.TG_TOKEN;
const TG_ID = process.env.TG_ID;
const PROXY_URL = process.env.PROXY_URL;
const T = parseInt(process.env.T || '12');                    // 总执行轮次
const BATCH_INDEX = parseInt(process.env.BATCH_INDEX || '0'); // 当前批次编号 (0-based)
const START_ROUND = parseInt(process.env.START_ROUND || '1'); // 0=自动续接, 1=全新开始, >1=手动指定
const ACCOUNTS_STR = process.env.ACCOUNTS || '';              // "1,2,3" 或 "SINGLE"
const ALL_SECRETS = JSON.parse(process.env.ALL_SECRETS || '{}');

const LOGIN_URL = 'https://www.back4app.com/login';
const DELAY_BETWEEN_RUNS = 60 * 60 * 1000;  // 轮次间隔：1 小时
const BATCH_DELAY = parseInt(process.env.BATCH_DELAY || '30'); // 批次间隔（分钟），用户可配
const INTER_BATCH_DELAY = BATCH_DELAY * 60 * 1000;

// 状态文件按批次隔离
const STATUS_FILE = `status_batch_${BATCH_INDEX}.json`;
const START_TIME = Date.now();
const MAX_EXECUTION_TIME = 5.5 * 60 * 60 * 1000; // 5.5 小时安全退出阈值

// ========== 解析本批次的账号列表 ==========
function parseAccounts() {
  const suffixes = ACCOUNTS_STR.split(',').map(s => s.trim()).filter(Boolean);
  return suffixes.map(suffix => {
    if (suffix === 'SINGLE') {
      return {
        suffix: 'SINGLE',
        email: ALL_SECRETS.EML,
        password: ALL_SECRETS.PWD,
        appName: ALL_SECRETS.APP_NAME || 'b4app',
      };
    }
    return {
      suffix,
      email: ALL_SECRETS[`EML_${suffix}`],
      password: ALL_SECRETS[`PWD_${suffix}`],
      appName: ALL_SECRETS[`APP_NAME_${suffix}`] || 'b4app',
    };
  });
}

// ========== 状态管理 ==========
function loadStatus() {
  try {
    if (fs.existsSync(STATUS_FILE)) {
      return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
    }
  } catch (e) {}
  return { currentRound: 1, lastRun: null };
}

function saveStatus(round) {
  const status = { currentRound: round, lastRun: new Date().toISOString() };
  fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));
}

// ========== TG 通知 ==========
async function sendTG(statusIcon, statusText, extra, imagePath, accountLabel) {
  if (!TG_TOKEN || !TG_ID) return;
  extra = extra || '';
  try {
    var time = new Date(Date.now() + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
    var text = 'Back4app 自动部署提醒\n' + statusIcon + ' ' + statusText + '\n' + extra + '\n账号: ' + accountLabel + '\n时间: ' + time;
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

// ========== GitHub Summary ==========
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

// ========== 重试机制 ==========
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

// ========== 单个账号的续期逻辑 ==========
async function runRenewLogic(page, account) {
  const { email, password, appName, suffix } = account;
  const prefix = suffix === 'SINGLE' ? '' : `[${suffix}] `;

  console.log(`${prefix}🌐 打开登录页`);
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('input[name="email"]', { timeout: 30000 });
  await page.screenshot({ path: `${suffix}_step1_login_page.png` });
  addToSummary(`${prefix}Step 1: 登录页`, `${suffix}_step1_login_page.png`);

  console.log(`${prefix}📧 填写邮箱密码`);
  await page.locator('input[name="email"], input[id="email"]').fill(email);
  await page.locator('input[name="password"], input[id="password"]').fill(password);
  await page.screenshot({ path: `${suffix}_step2_filled.png` });
  addToSummary(`${prefix}Step 2: 填写信息`, `${suffix}_step2_filled.png`);

  console.log(`${prefix}🖱️ 点击 Continue`);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  
  console.log(`${prefix}⏳ 等待控制台加载...`);
  await page.waitForURL('**/dashboard**', { timeout: 60000 });
  await page.waitForLoadState('load');
  await page.screenshot({ path: `${suffix}_step3_dashboard.png` });
  addToSummary(`${prefix}Step 3: 登录成功`, `${suffix}_step3_dashboard.png`);

  await page.waitForTimeout(5000);

  console.log(`${prefix}🖱️ 点击 Web Deployment 选项卡`);
  await retry(page, async () => {
    const webDeploymentTab = page.locator('a:has-text("Web Deployment"), button:has-text("Web Deployment")').filter({ visible: true }).first();
    await webDeploymentTab.waitFor({ state: 'visible', timeout: 30000 });
    await webDeploymentTab.click();
  }, `${prefix}点击 Web Deployment`);
  await page.screenshot({ path: `${suffix}_step3.5_web_deployment.png` });
  addToSummary(`${prefix}Step 3.5: Web Deployment`, `${suffix}_step3.5_web_deployment.png`);

  console.log(`${prefix}🖱️ 选择应用 "${appName}"`);
  await retry(page, async () => {
    const loading = page.locator('text=Loading...').first();
    if (await loading.isVisible()) {
        console.log(`${prefix}⏳ 正在加载列表，等待中...`);
        await loading.waitFor({ state: 'hidden', timeout: 30000 });
    }
    const appLink = page.locator(`text=${appName}`).filter({ visible: true }).first();
    await appLink.waitFor({ state: 'visible', timeout: 30000 });
    await appLink.click({ delay: 500 });
  }, `${prefix}选择应用 ${appName}`);

  await page.waitForLoadState('load');
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${suffix}_step4_app_detail.png` });
  addToSummary(`${prefix}Step 4: 应用详情页`, `${suffix}_step4_app_detail.png`);

  console.log(`${prefix}🔍 检查当前实例状态...`);
  
  // 尝试 5 秒内找到 Redeploy 按钮：找到说明需要重部署，没找到说明实例是活的
  const redeployBtn = page.locator('button:has-text("Redeploy App"), a:has-text("Redeploy App")').filter({ visible: true }).first();
  
  let needsRedeploy = false;
  try {
    await redeployBtn.waitFor({ state: 'visible', timeout: 5000 });
    needsRedeploy = true;
  } catch (error) {
    needsRedeploy = false;
  }
  
  if (!needsRedeploy) {
    console.log(`${prefix}✅ 应用处于活跃状态，无需重新部署，跳过。`);
    await page.screenshot({ path: `${suffix}_step5_redeploying.png` });
    addToSummary(`${prefix}Step 5: 已活跃`, `${suffix}_step5_redeploying.png`);
    return;
  }

  console.log(`${prefix}🚀 实例需要唤醒，正在点击 "Redeploy App"...`);
  await retry(page, async () => {
    await redeployBtn.click();
  }, `${prefix}点击 Redeploy App`);

  console.log(`${prefix}⏳ 智能等待状态变更为 Deploying...`);
  try {
    await page.waitForSelector('text="Deploying"', { state: 'visible', timeout: 30000 });
    console.log(`${prefix}✅ 成功检测到 Deploying 状态！`);
  } catch (error) {
    console.log(`${prefix}⚠️ 未检测到 Deploying，可能部署极快已变为 Running，继续执行...`);
  }
  
  await page.screenshot({ path: `${suffix}_step5_redeploying.png` });
  addToSummary(`${prefix}Step 5: 部署状态确认`, `${suffix}_step5_redeploying.png`);

  console.log(`${prefix}✅ 部署操作完成`);
}

// ========== 主函数 ==========
(async function main() {
  const accounts = parseAccounts();
  
  console.log('==================================================');
  console.log('Back4app 自动重新部署 (批次模式)');
  console.log(`批次: ${BATCH_INDEX}, 本批账号数: ${accounts.length}, 总轮次: ${T}, START_ROUND: ${START_ROUND}`);
  console.log(`账号列表: ${accounts.map(a => a.suffix).join(', ')}`);
  console.log('==================================================');

  // 校验凭据
  for (const acc of accounts) {
    if (!acc.email || !acc.password) {
      console.log(`❌ 账号 ${acc.suffix} 未找到邮箱或密码，跳过整个批次`);
      process.exit(1);
    }
  }

  // 确定起始轮次
  let startRound;
  if (START_ROUND === 0) {
    // 自动续接模式：从状态文件读取
    const status = loadStatus();
    startRound = status.currentRound;
    console.log(`📂 自动续接模式：从状态文件读取，起始轮次 = ${startRound}`);
  } else if (START_ROUND === 1) {
    // 全新开始：清理旧状态文件
    if (fs.existsSync(STATUS_FILE)) {
      console.log(`🧹 发现残留的进度文件 ${STATUS_FILE}，清理以确保全新启动。`);
      fs.unlinkSync(STATUS_FILE);
    }
    startRound = 1;
  } else {
    // 手动指定轮次
    startRound = START_ROUND;
    console.log(`🔧 手动指定模式：起始轮次 = ${startRound}`);
  }

  // 批次间错峰延迟：只在首轮执行，非续接场景
  if (startRound === 1 && BATCH_INDEX > 0) {
    const batchDelay = BATCH_INDEX * INTER_BATCH_DELAY;
    console.log(`⏳ 批次 ${BATCH_INDEX}：等待 ${batchDelay / 60000} 分钟后启动 (批次间隔 ${BATCH_DELAY} 分钟)...`);
    await new Promise(r => setTimeout(r, batchDelay));
  } else if (startRound === 1) {
    console.log(`⏳ 批次 0：首发批次，立刻启动！`);
  }

  // ===== 主循环：每轮依次处理本批次内的所有账号 =====
  for (let round = startRound; round <= T; round++) {
    const elapsedTime = Date.now() - START_TIME;
    if (elapsedTime > MAX_EXECUTION_TIME) {
      console.log(`⏳ 运行时间接近极限 (${(elapsedTime/3600000).toFixed(2)}h)，保存进度并退出...`);
      saveStatus(round);
      break;
    }

    console.log(`\n========== 第 ${round}/${T} 轮 ==========`);

    for (let i = 0; i < accounts.length; i++) {
      const account = accounts[i];
      const prefix = account.suffix === 'SINGLE' ? '' : `[${account.suffix}] `;
      console.log(`\n----- ${prefix}账号 ${i + 1}/${accounts.length} -----`);

      var launchOpts = { headless: true, channel: 'chrome' };
      if (PROXY_URL) launchOpts.proxy = { server: 'http://127.0.0.1:8080' };
      
      var browser = await chromium.launch(launchOpts);
      var context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
      var page = await context.newPage();

      try {
        await runRenewLogic(page, account);
        await sendTG('✅', `第 ${round}/${T} 轮成功`, `应用: ${account.appName}`, `${account.suffix}_step5_redeploying.png`, account.email);
      } catch (error) {
        console.log(`${prefix}❌ 本轮失败: ${error.message}`);
        await page.screenshot({ path: `${account.suffix}_failure.png` });
        addToSummary(`${prefix}❌ 流程失败`, `${account.suffix}_failure.png`);
        await sendTG('❌', `第 ${round}/${T} 轮失败`, `应用: ${account.appName}\n${error.message}`, `${account.suffix}_failure.png`, account.email);
      } finally {
        await context.close();
        await browser.close();
      }
    }

    saveStatus(round + 1);

    if (round < T) {
      console.log(`\n⏳ 第 ${round} 轮全部账号处理完毕，等待 1 小时后进入第 ${round + 1} 轮...`);
      await new Promise(r => setTimeout(r, DELAY_BETWEEN_RUNS));
    }
  }

  console.log('\n✅ 本批次所有轮次执行完成');
  await sendTG('✅', '全部完成', `批次 ${BATCH_INDEX}，共 ${T} 轮 × ${accounts.length} 个账号`, null, `批次 ${BATCH_INDEX}`);
})();
