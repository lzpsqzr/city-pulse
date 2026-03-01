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
  priorityAreas: ['新江湾城', '新江湾', '杨浦', '内环', '中环', '中外环', '中内环'],
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
    const html = execSync(`curl -s --compressed '${url}' -H 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'`, {
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
    newProperties: [],
    resaleProperties: []
  };

  // Extract resale average price
  const resaleMatch = html.match(/二手房参考均价[\s\S]*?<span>\s*(\d[\d,]*)\s*<\/span>\s*元\/平/);
  if (resaleMatch) {
    data.metrics.resale.avgPrice = parsePrice(resaleMatch[1]);
  }

  // Extract new home average price and change (updated for new page structure)
  const newMatch = html.match(/新房参考均价[\s\S]*?<span>(\d[\d,]*)<\/span>\s*元\/平[\s\S]*?比上月(上涨|下跌)\s*(\d+\.?\d*)%/);
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
    
    // Parse property listings from <li> elements
    const liPattern = /<li id="lp_(\d+)"[\s\S]*?<\/li>/g;
    let liMatch;
    
    while ((liMatch = liPattern.exec(html)) !== null) {
      const liHtml = liMatch[0];
      
      // Extract property URL
      const urlMatch = liHtml.match(/href="(https:\/\/sh\.newhouse\.fang\.com\/loupan\/\d+\.htm)"/);
      if (!urlMatch) continue;
      const url = urlMatch[1];
      
      // Extract name
      const nameMatch = liHtml.match(/<a target="_blank"[^>]*>([^<]+)<\/a>[\s\S]*?<\/div>[\s\S]*?<div class="house_type/);
      if (!nameMatch) continue;
      const name = nameMatch[1].trim();
      
      // Extract location (ringLocation like 内环以内, 中外环间)
      const locMatch = liHtml.match(/\[([^\]]+)\]([^<]+)/);
      if (!locMatch) continue;
      const ringLocation = locMatch[1].trim();
      let address = locMatch[2].trim();
      // Clean up address - remove HTML artifacts
      address = address.replace(/"\s*target="_blank".*$/g, '').trim();
      
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
      
      // Extract status
      const statusMatch = liHtml.match(/<span class="(\w+)Sale">/);
      const status = statusMatch ? (statusMatch[1] === 'in' ? '在售' : statusMatch[1] === 'for' ? '待售' : '售完') : '';
      
      if (unitPrice && status === '在售') {
        properties.push({
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
    
    console.log(`   Found ${properties.length} new properties in total\n`);
    
  } catch (error) {
    console.error(`   ⚠️ Failed to fetch new properties: ${error.message}`);
  }
  
  return properties;
}

// Fetch resale properties from multiple districts
function fetchResaleProperties() {
  const properties = [];
  
  try {
    console.log('   Fetching resale properties (新江湾城 + other districts)...');
    
    // Area URLs to fetch (district code, area name, priority)
    const areas = [
      { url: 'https://sh.esf.fang.com/house-a026-b01651/', district: '杨浦', area: '新江湾城', priority: 1 },
      { url: 'https://sh.esf.fang.com/house-a024/', district: '黄浦', area: '黄浦全区', priority: 2 },
      { url: 'https://sh.esf.fang.com/house-a019/', district: '徐汇', area: '徐汇全区', priority: 3 },
      { url: 'https://sh.esf.fang.com/house-a021/', district: '静安', area: '静安全区', priority: 4 },
      { url: 'https://sh.esf.fang.com/house-a020/', district: '长宁', area: '长宁全区', priority: 5 },
      { url: 'https://sh.esf.fang.com/house-a025/', district: '浦东', area: '浦东全区', priority: 6 }
    ];
    
    for (const areaInfo of areas) {
      try {
        const html = fetchHTML(areaInfo.url);
        
        // Parse property listings - find all <dl class="clearfix"> elements
        const dlPattern = /<dl class="clearfix[^"]*"[^>]*data-bg="[^"]*"[^>]*>([\s\S]*?)<\/dl>/g;
        let dlMatch;
        let areaCount = 0;
        
        while ((dlMatch = dlPattern.exec(html)) !== null) {
          const dlHtml = dlMatch[1];
          
          // Extract URL
          const urlMatch = dlHtml.match(/href="(\/chushou\/3_\d+\.htm)"/);
          if (!urlMatch) continue;
          const url = 'https://sh.esf.fang.com' + urlMatch[1];
          
          // Extract community name - more flexible pattern
          const communityMatch = dlHtml.match(/<a target="_blank" href="\/house-xm\d+\/"[^>]*>([^<]+)<\/a>/);
          if (!communityMatch) continue;
          const community = communityMatch[1].trim();
          
          // Extract title/description
          const titleMatch = dlHtml.match(/<span class="tit_shop">\s*([^<]+)<\/span>/);
          const title = titleMatch ? titleMatch[1].trim() : '';
          
          // Extract layout and area (e.g., "4室2厅 | 89㎡")
          const layoutMatch = dlHtml.match(/(\d室\d厅)\s*<i>\|<\/i>\s*([\d.]+)㎡/);
          if (!layoutMatch) continue;
          const layout = layoutMatch[1];
          const areaSize = parseFloat(layoutMatch[2]);
          
          // Extract total price
          const priceMatch = dlHtml.match(/<b>(\d+)<\/b>万/);
          if (!priceMatch) continue;
          const totalPrice = parseInt(priceMatch[1]);
          
          // Only keep properties under 700万
          if (totalPrice > PREFERENCES.maxTotalPrice) continue;
          
          // Extract unit price
          const unitPriceMatch = dlHtml.match(/(\d+)元\/㎡/);
          const unitPrice = unitPriceMatch ? parseInt(unitPriceMatch[1]) : Math.round(totalPrice * 10000 / areaSize);
          
          // Extract address
          const addressMatch = dlHtml.match(/<span>([^<]+)<\/span>\s*<\/p>[\s\S]*?<dd class="price_right">/);
          const address = addressMatch ? addressMatch[1].trim() : '';
          
          properties.push({
            community,
            title,
            url,
            totalPrice,
            unitPrice,
            layout,
            area: areaSize,
            district: areaInfo.district,
            areaName: areaInfo.area,
            address,
            priority: areaInfo.priority
          });
          
          areaCount++;
          if (areaCount >= 8) break; // Limit per area
        }
        
        console.log(`   ${areaInfo.area}: ${areaCount} properties`);
        
      } catch (e) {
        console.log(`   ${areaInfo.area}: failed (${e.message})`);
      }
    }
    
    console.log(`   Total: ${properties.length} resale properties under ${PREFERENCES.maxTotalPrice}万\n`);
    
  } catch (error) {
    console.error(`   ⚠️ Failed to fetch resale properties: ${error.message}`);
  }
  
  return properties;
}

// Selection algorithm for property recommendations
// Factors: location priority, unit price range, total budget fit
function selectBestProperties(properties) {
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
  
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, PREFERENCES.maxProperties)
    .map(({ score, ...p }) => p);
}

// Select best resale properties: prioritize 新江湾城 (2 units), then add other areas
function selectBestResaleProperties(properties) {
  // Separate 新江湾城 properties and others
  const xinjiangwan = properties.filter(p => p.areaName === '新江湾城');
  const others = properties.filter(p => p.areaName !== '新江湾城');
  
  // Select top 2 from 新江湾城 (sorted by unit price - better value)
  const selectedXJW = xinjiangwan
    .sort((a, b) => a.unitPrice - b.unitPrice)
    .slice(0, 2);
  
  // Select top properties from other areas (sorted by unit price)
  const selectedOthers = others
    .sort((a, b) => a.unitPrice - b.unitPrice)
    .slice(0, 8);
  
  // Combine: 新江湾城 first, then others
  return [...selectedXJW, ...selectedOthers];
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
    const allNewProperties = fetchNewProperties();
    data.newProperties = selectBestProperties(allNewProperties);
    console.log(`   Selected top ${data.newProperties.length} new properties\n`);
    
    // Fetch resale properties
    console.log('📡 Fetching resale properties (新江湾城, <700万)...');
    const allResaleProperties = fetchResaleProperties();
    data.resaleProperties = selectBestResaleProperties(allResaleProperties);
    console.log(`   Selected top ${data.resaleProperties.length} resale properties\n`);
    
    // Calculate resale change from history
    try {
      const historyFile = path.join(HISTORY_DIR, `${new Date().toISOString().split('T')[0]}.json`);
      const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
      const yesterdayFile = path.join(HISTORY_DIR, `${yesterday}.json`);
      
      if (fs.existsSync(yesterdayFile)) {
        const yesterdayData = JSON.parse(fs.readFileSync(yesterdayFile, 'utf-8'));
        const yesterdayPrice = yesterdayData.metrics?.resale?.avgPrice;
        const todayPrice = data.metrics.resale.avgPrice;
        
        if (yesterdayPrice && todayPrice) {
          const change = ((todayPrice - yesterdayPrice) / yesterdayPrice * 100).toFixed(2);
          data.metrics.resale.change = parseFloat(change);
          console.log(`   Calculated resale change: ${change}% from yesterday\n`);
        }
      }
    } catch (e) {
      console.log(`   Could not calculate resale change: ${e.message}\n`);
    }
    
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
      });
    }

    if (data.resaleProperties.length > 0) {
      console.log('\n   精选二手房推荐 (新江湾城, <700万, 按性价比排序):');
      data.resaleProperties.forEach((p, i) => {
        console.log(`   ${i + 1}. [${p.areaName}] ${p.community}: ${p.totalPrice}万 (${p.unitPrice.toLocaleString()}元/㎡) - ${p.layout} ${p.area}㎡`);
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
