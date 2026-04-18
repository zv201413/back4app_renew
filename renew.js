const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ACC = process.env.ACC || process.env.EML;
const ACC_PWD = process.env.ACC_PWD || process.env.PWD;
const TG_TOKEN = process.env.TG_TOKEN;
const TG_ID = process.env.TG_ID;
const PROXY_URL = process.env.PROXY_URL;
const APP_NAME = process.env.APP_NAME || 'b4app';
const T = parseInt(process.env.T || '12'); // 执行次数，默认12次
const ACCOUNT_INDEX = parseInt(process.env.ACCOUNT_INDEX || '0'); // 账号严格按0,1,2排序
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '1'); // 每组包含的账号个数
const START_ROUND = parseInt(process.env.START_ROUND || '1'); // 起始轮次（用于分段模式）

const LOGIN_URL = 'https://www.back4app.com/login';
const DELAY_BETWEEN_RUNS = 60 * 60 * 1000; // 1小时 = 3600000ms

// 状态文件路径，按账号隔离
const STATUS_FILE = `status_${ACCOUNT_INDEX}.json`;
const START_TIME = Date.now();
const MAX_EXECUTION_TIME = 5.5 * 60 * 60 * 1000; // 5.5 小时安全退出阈值

function loadStatus() {
  try {
    if (fs.existsSync(STATUS_FILE)) {
      return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
    }
  } catch (e) {}
  return { currentRound: START_ROUND > 1 ? START_ROUND : 1, lastRun: null };
}

function saveStatus(round) {
  const status = { currentRound: round, lastRun: new Date().toISOString() };
  fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));
}

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
  console.log(`执行次数: ${T}, 账号索引: ${ACCOUNT_INDEX}, 每组个数: ${BATCH_SIZE}, 起始轮次: ${START_ROUND}`);
  console.log('==================================================');

  if (!ACC || !ACC_PWD) { console.log('❌ 未找到账号或密码'); process.exit(1); }

  // 如果是从第1轮开始的全新任务，主动清理该账号残留的旧状态文件，防止被旧进度干扰直接结束
  if (START_ROUND === 1) {
    if (fs.existsSync(STATUS_FILE)) {
      console.log(`🧹 发现残留的进度文件 ${STATUS_FILE}，清理以确保全新启动。`);
      fs.unlinkSync(STATUS_FILE);
    }
  }

  const status = loadStatus();
  let startRound = START_ROUND > 1 ? START_ROUND : status.currentRound;

  // 动态分组错峰延迟计算：
  // 只有第一轮跑的时候才需要安排发车时间轴（非中途恢复）
  if (startRound === 1) {
    // 计算属于第几组 (0-based)
    const batchIndex = Math.floor(ACCOUNT_INDEX / BATCH_SIZE);
    // 计算在组内的位置 (0-based)
    const positionInBatch = ACCOUNT_INDEX % BATCH_SIZE;

    // 组间延迟：每组错开 30 分钟
    // 组内延迟：模拟“紧挨着依次执行”，Playwright 跑完一个号大约需要 1.5 到 2 分钟，我们错开 2 分钟即可完美衔接
    let initialDelay = (batchIndex * 30 * 60 * 1000) + (positionInBatch * 2 * 60 * 1000);
    
    if (initialDelay > 0) {
      console.log(`⏳ 分组排队：本账号属于第 ${batchIndex + 1} 组，组内排第 ${positionInBatch + 1} 位。`);
      console.log(`⏳ 发车时间轴规划：将在 ${initialDelay / 60000} 分钟后正式启动...`);
      await new Promise(r => setTimeout(r, initialDelay));
    } else {
      console.log(`⏳ 分组排队：首发账号，立刻发车！`);
    }
  }

  for (let round = startRound; round <= T; round++) {
    const elapsedTime = Date.now() - START_TIME;
    if (elapsedTime > MAX_EXECUTION_TIME) {
      console.log(`⏳ 运行时间接近极限 (${(elapsedTime/3600000).toFixed(2)}h)，主动挂起，等待下一波分段启动...`);
      // 将下一轮的数值记录下来
      saveStatus(round);
      break;
    }

    console.log(`\n===== 第 ${round}/${T} 轮 =====`);
    saveStatus(round + 1); // 预存下一轮进度，如果当前轮成功，下次就从下一轮开始

    var launchOpts = { headless: true, channel: 'chrome' };
    if (PROXY_URL) launchOpts.proxy = { server: 'http://127.0.0.1:8080' };
    
    var browser = await chromium.launch(launchOpts);
    var context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    var page = await context.newPage();

    try {
      await runRenewLogic(page);
      await sendTG('✅', `第 ${round}/${T} 轮成功`, '已点击 Redeploy App', 'step5_redeploying.png');
    } catch (error) {
      console.log('❌ 本轮失败: ' + error.message);
      await page.screenshot({ path: 'failure.png' });
      addToSummary('❌ 流程失败', 'failure.png');
      await sendTG('❌', `第 ${round}/${T} 轮失败`, error.message, 'failure.png');
    } finally {
      await context.close();
      await browser.close();
    }

    if (round < T) {
      console.log(`⏳ 等待 1 小时后继续...`);
      await new Promise(r => setTimeout(r, DELAY_BETWEEN_RUNS));
    }
  }

  console.log('✅ 所有轮次执行完成');
  await sendTG('✅', '全部完成', `共执行 ${T} 轮`, 'step5_redeploying.png');
})();

async function runRenewLogic(page) {
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
    const loading = page.locator('text=Loading...').first();
    if (await loading.isVisible()) {
        console.log('⏳ 正在加载列表，等待中...');
        await loading.waitFor({ state: 'hidden', timeout: 30000 });
    }
    const appSelector = `text=${APP_NAME}`;
    const appLink = page.locator(appSelector).filter({ visible: true }).first();
    await appLink.waitFor({ state: 'visible', timeout: 30000 });
    await appLink.click({ delay: 500 });
  }, `选择应用 ${APP_NAME}`);

  console.log('⏳ 等待应用详情页加载...');
  await page.waitForLoadState('load');
  await page.waitForTimeout(3000); 
  await page.screenshot({ path: 'step4_app_detail.png' });
  addToSummary('Step 4: 应用详情页', 'step4_app_detail.png');

  console.log('🔍 检查当前实例状态...');
  
  // 尝试短时间内寻找 Redeploy 按钮（最多等 5 秒）
  // 这里的逻辑是：如果实例需要重启，按钮肯定很快就在页面上。如果不在，说明它是活的。
  const redeployBtn = page.locator('button:has-text("Redeploy App"), a:has-text("Redeploy App")').filter({ visible: true }).first();
  
  let needsRedeploy = false;
  try {
    await redeployBtn.waitFor({ state: 'visible', timeout: 5000 });
    needsRedeploy = true; // 按钮出现了，说明需要抢救
  } catch (error) {
    // 5秒内没找到按钮
    needsRedeploy = false;
  }
  
  if (!needsRedeploy) {
    console.log('✅ 检测到当前应用处于活跃状态 (Available/Deploying 等)，无需重新部署，跳过点击。');
    await page.screenshot({ path: 'step5_redeploying.png' });
    addToSummary('Step 5: 部署状态确认 (已活跃)', 'step5_redeploying.png');
    return; // 提前结束本轮，视为成功
  }

  console.log('🚀 实例需要唤醒，正在点击 "Redeploy App"...');
  await retry(page, async () => {
    // 因为前面已经 waitFor 确保它出现了，这里直接点
    await redeployBtn.click();
  }, '点击 Redeploy App');

  console.log('⏳ 智能等待状态变更为 Deploying...');
    try {
      // 动态等待页面上出现 Deploying 文本，最长等 30 秒
      await page.waitForSelector('text="Deploying"', { state: 'visible', timeout: 30000 });
      console.log('✅ 成功检测到 Deploying 状态！');
    } catch (error) {
      console.log('⚠️ 未能在 30 秒内检测到 Deploying 状态，可能部署极快已变为 Running，或页面结构有变，继续执行...');
    }
    
    // 无论是否捕捉到 Deploying，都截个图留档
    await page.screenshot({ path: 'step5_redeploying.png' });
    addToSummary('Step 5: 部署状态确认', 'step5_redeploying.png');

  console.log('✅ 部署操作完成');
}
