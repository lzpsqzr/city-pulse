#!/usr/bin/env node
/**
 * City Pulse - Data Collector
 * Fetches urban metrics data and saves to JSON files
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const LATEST_FILE = path.join(DATA_DIR, 'latest.json');
const HISTORY_DIR = path.join(DATA_DIR, 'history');

// User preferences for property selection
const PREFERENCES = {
  // 优先区域（按优先级排序）
  priorityAreas: ['新江湾', '杨浦', '内环', '中环', '中外环', '中内环'],
  // 最高总价（万）
  maxTotalPrice: 700,
  // 单价范围（元/㎡）
  minUnitPrice: 30000,
  maxUnitPrice: 100000,
  // 最多展示楼盘数
  maxProperties: 10
};

// Fetch HTML using curl
function fetchHTML(url) {
  try {
    const html = execSync(`curl -s '${url}' -H 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'`, {
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024
    });
    return html;
  } catch (error) {
    throw new Error(`Failed to fetch ${url}: ${error.message}`);
  }
}

// Parse price value
function parsePrice(text) {
  const cleaned = text.replace(/[,\s]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

// Extract data from fangjia.fang.com HTML
function parseFangjiaHTML(html) {
  const data = {
    updatedAt: new Date().toISOString(),
    city: '上海',
    metrics: {
      resale: { avgPrice: null, unit: '元/平米', change: null },
      new: { avgPrice: null, unit: '元/平米', change: null }
    },
    districts: [],
    newProperties: []
  };

  // Extract resale average price
  const resaleMatch = html.match(/二月二手房参考均价[\s\S]*?<span>\s*(\d[\d,]*)\s*<\/span>\s*元\/平/);
  if (resaleMatch) {
    data.metrics.resale.avgPrice = parsePrice(resaleMatch[1]);
  }

  // Extract new home average price and change
  const newMatch = html.match(/二月新房参考均价[\s\S]*?<span>(\d[\d,]*)<\/span>\s*元\/平[\s\S]*?比上月(下跌|上涨)(\d+\.?\d*)%/);
  if (newMatch) {
    data.metrics.new.avgPrice = parsePrice(newMatch[1]);
    const change = parseFloat(newMatch[3]);
    data.metrics.new.change = newMatch[2] === '下跌' ? -change : change;
  }

  // Extract ALL district prices
  const allDistricts = [
    '黄浦', '徐汇', '静安', '长宁', '虹口', '普陀', '杨浦', '闵行', '浦东', 
    '青浦', '宝山', '嘉定', '松江', '奉贤', '金山', '崇明'
  ];
  
  for (const district of allDistricts) {
    const pattern = new RegExp(
      `<a href="/sh/a\\d+/"[^>]*>${district}</a><span class="pm-price">(\\d[\\d,]*)元/平</span>[\\s\\S]*?` +
      `<span>环比上月</span><span class="f12 pm-rate">[\\s]*(\\d+\\.?\\d*)%[\\s]*<i[^>]*>(↓|↑)</i>`,
      'g'
    );
    
    const match = pattern.exec(html);
    if (match) {
      const price = parsePrice(match[1]);
      const changeVal = parseFloat(match[2]);
      const change = match[3] === '↓' ? -changeVal : changeVal;
      
      if (price) {
        data.districts.push({ name: district, price, change });
      }
    }
  }

  return data;
}

// Fetch new properties from list page and apply selection logic
function fetchNewProperties() {
  const properties = [];
  
  try {
    console.log('   Fetching new property listings...');
    const html = fetchHTML('https://sh.newhouse.fang.com/house/s/');
    
    // Parse property listings
    // Pattern: <li id="lp_XXXXXX">...<a href="...loupan/XXXXXX.htm">楼盘名</a>...
    //          ...[区域位置]...<span>价格</span><em>元/㎡</em>...
    
    const liPattern = /<li id="lp_(\d+)"[\s\S]*?<\/li>/g;
    let liMatch;
    
    while ((liMatch = liPattern.exec(html)) !== null) {
      const liHtml = liMatch[0];
      
      // Extract property ID and URL
      const newcode = liMatch[1];
      const urlMatch = liHtml.match(/href="(https:\/\/sh\.newhouse\.fang\.com\/loupan\/\d+\.htm)"/);
      if (!urlMatch) continue;
      const url = urlMatch[1];
      
      // Extract name
      const nameMatch = liHtml.match(/<a target="_blank"[^>]*>([^<]+)<\/a>[\s\S]*?<\/div>[\s\S]*?<div class="house_type/);
      if (!nameMatch) continue;
      const name = nameMatch[1].trim();
      
      // Extract location (区域 + 位置)
      const locMatch = liHtml.match(/\[([^\]]+)\]([^<]+)/);
      if (!locMatch) continue;
      const ringLocation = locMatch[1].trim(); // 如：内环以内、中外环间
      const address = locMatch[2].trim();
      
      // Extract district
      const districtMatch = liHtml.match(/<span class="sngrey">\s*\[([^\]]+)\]/);
      const district = districtMatch ? districtMatch[1].trim() : '';
      
      // Extract price
      const priceMatch = liHtml.match(/<span>(\d[\d,]*)<\/span><em>元\/㎡/);
      const totalPriceMatch = liHtml.match(/(\d+)万元\/套起/);
      
      if (!priceMatch) continue;
      
      const unitPrice = parsePrice(priceMatch[1]);
      const totalPrice = totalPriceMatch ? parseInt(totalPriceMatch[1]) : null;
      
      // Extract layout
      const layoutMatch = liHtml.match(/(<a[^>]*>[\u4e00-\u9fa5]+<\/a>\s*\/?\s*)+—[\d~]+平米/);
      const layout = layoutMatch ? layoutMatch[0].replace(/<[^>]+>/g, '').trim() : '';
      
      // Extract status (在售/待售)
      const statusMatch = liHtml.match(/<span class="(\w+)Sale">/);
      const status = statusMatch ? (statusMatch[1] === 'in' ? '在售' : statusMatch[1] === 'for' ? '待售' : '售完') : '';
      
      if (unitPrice && status === '在售') {
        properties.push({
          newcode,
          name,
          url,
          district,
          ringLocation,
          address,
          unitPrice,
          totalPrice,
          layout,
          status
        });
      }
    }
    
    console.log(`   Found ${properties.length} properties in total\n`);
    
  } catch (error) {
    console.error(`   ⚠️ Failed to fetch new properties: ${error.message}`);
  }
  
  return properties;
}

// Select best properties based on user preferences
function selectBestProperties(properties) {
  // 计算每个楼盘的优先级分数
  const scored = properties.map(p => {
    let score = 0;
    
    // 区域优先级加分
    for (let i = 0; i < PREFERENCES.priorityAreas.length; i++) {
      if (p.ringLocation.includes(PREFERENCES.priorityAreas[i]) || 
          p.district.includes(PREFERENCES.priorityAreas[i]) ||
          p.address.includes(PREFERENCES.priorityAreas[i])) {
        score += (PREFERENCES.priorityAreas.length - i) * 10;
        break;
      }
    }
    
    // 价格在范围内加分
    if (p.unitPrice >= PREFERENCES.minUnitPrice && p.unitPrice <= PREFERENCES.maxUnitPrice) {
      score += 20;
    }
    
    // 总价在预算内加分
    if (p.totalPrice && p.totalPrice <= PREFERENCES.maxTotalPrice) {
      score += 30;
      // 越接近预算上限分数越高（性价比）
      score += Math.floor((p.totalPrice / PREFERENCES.maxTotalPrice) * 10);
    }
    
    // 价格越低额外加分（性价比）
    if (p.unitPrice < 60000) score += 5;
    else if (p.unitPrice < 80000) score += 3;
    
    return { ...p, score };
  });
  
  // 按分数排序，取前 N 个
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, PREFERENCES.maxProperties)
    .map(({ score, ...p }) => p); // 移除 score 字段
}

// Main function
async function main() {
  console.log('🏙️ City Pulse - Data Collector');
  console.log('==============================\n');

  try {
    // Fetch main data
    console.log('📡 Fetching main data...');
    const html = fetchHTML('https://fangjia.fang.com/sh/');
    console.log(`   Received ${html.length} bytes\n`);

    // Parse data
    console.log('🔍 Parsing data...');
    const data = parseFangjiaHTML(html);
    
    // Fetch new properties with selection
    console.log('📡 Fetching new properties (prioritizing your preferences)...');
    const allProperties = fetchNewProperties();
    data.newProperties = selectBestProperties(allProperties);
    console.log(`   Selected top ${data.newProperties.length} properties based on preferences\n`);
    
    // Display results
    console.log('\n📊 Results:');
    console.log(`   Updated: ${data.updatedAt}`);
    console.log(`   Resale avg: ${data.metrics.resale.avgPrice?.toLocaleString() || 'N/A'} ${data.metrics.resale.unit}`);
    console.log(`   New avg: ${data.metrics.new.avgPrice?.toLocaleString() || 'N/A'} ${data.metrics.new.unit} (${data.metrics.new.change || 'N/A'}%)`);
    console.log(`   Districts: ${data.districts.length}`);
    
    if (data.districts.length > 0) {
      console.log('\n   所有区县房价:');
      data.districts.sort((a, b) => b.price - a.price).forEach((d, i) => {
        const changeStr = d.change !== null ? ` (${d.change > 0 ? '+' : ''}${d.change}%)` : '';
        console.log(`   ${(i + 1).toString().padStart(2)}. ${d.name}: ${d.price.toLocaleString()} 元/平米${changeStr}`);
      });
    }

    if (data.newProperties.length > 0) {
      console.log('\n   精选新房推荐 (按偏好排序):');
      data.newProperties.forEach((p, i) => {
        const priceStr = p.totalPrice 
          ? `${p.totalPrice}万起 (${p.unitPrice.toLocaleString()}元/㎡)`
          : `${p.unitPrice.toLocaleString()}元/㎡`;
        console.log(`   ${i + 1}. [${p.ringLocation}] ${p.district} - ${p.name}: ${priceStr}`);
        console.log(`      ${p.layout} | ${p.address.slice(0, 30)}...`);
      });
    }

    // Ensure directories exist
    if (!fs.existsSync(HISTORY_DIR)) {
      fs.mkdirSync(HISTORY_DIR, { recursive: true });
    }

    // Save latest data
    console.log('\n💾 Saving data...');
    fs.writeFileSync(LATEST_FILE, JSON.stringify(data, null, 2));
    console.log(`   ✅ Saved to ${LATEST_FILE}`);

    // Save to history
    const today = new Date().toISOString().split('T')[0];
    const historyFile = path.join(HISTORY_DIR, `${today}.json`);
    fs.writeFileSync(historyFile, JSON.stringify(data, null, 2));
    console.log(`   ✅ Saved to ${historyFile}`);

    console.log('\n✨ Done!');

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

main();
