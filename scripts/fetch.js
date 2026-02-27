#!/usr/bin/env node
/**
 * City Pulse - Data Collector
 * Fetches urban metrics data and saves to JSON files
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const LATEST_FILE = path.join(DATA_DIR, 'latest.json');
const HISTORY_DIR = path.join(DATA_DIR, 'history');

// Fetch HTML content from URL
async function fetchHTML(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
    }
  });
  
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  
  return response.text();
}

// Parse price value from text
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
    districts: []
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

  // Extract district prices from "上海二手房区县房价榜" section
  // Format: <a href="/sh/a024/" target="_blank">黄浦</a><span class="pm-price">99502元/平</span>
  // Followed by: <span>环比上月</span><span class="f12 pm-rate"> 0.72% <i ...>↓</i></span>
  
  const districtSection = html.match(/上海二手房区县房价榜[\s\S]*?<div class="down5 none">/);
  if (districtSection) {
    const sectionHTML = districtSection[0];
    
    // Match each district entry
    const entryPattern = /<a href="\/sh\/a\d+\/"[^>]*>([^<]+)<\/a><span class="pm-price">(\d[\d,]*)元\/平<\/span>[\s\S]*?环比上月[\s]*<\/span><span class="f12 pm-rate">[\s]*(\d+\.?\d*)%\s*<i[^>]*>(↓|↑)<\/i>/g;
    
    let match;
    while ((match = entryPattern.exec(sectionHTML)) !== null) {
      const name = match[1].trim();
      const price = parsePrice(match[2]);
      const changeVal = parseFloat(match[3]);
      const change = match[4] === '↓' ? -changeVal : changeVal;
      
      if (price && name) {
        data.districts.push({ name, price, change });
      }
    }
  }

  return data;
}

// Main function
async function main() {
  console.log('🏙️ City Pulse - Data Collector');
  console.log('==============================\n');

  try {
    // Fetch data
    console.log('📡 Fetching data...');
    const html = await fetchHTML('https://fangjia.fang.com/sh/');
    console.log(`   Received ${html.length} bytes\n`);

    // Parse data
    console.log('🔍 Parsing data...');
    const data = parseFangjiaHTML(html);
    
    // Display results
    console.log('\n📊 Results:');
    console.log(`   Updated: ${data.updatedAt}`);
    console.log(`   Resale avg: ${data.metrics.resale.avgPrice?.toLocaleString() || 'N/A'} ${data.metrics.resale.unit}`);
    console.log(`   New avg: ${data.metrics.new.avgPrice?.toLocaleString() || 'N/A'} ${data.metrics.new.unit} (${data.metrics.new.change || 'N/A'}%)`);
    console.log(`   Districts: ${data.districts.length}`);
    
    if (data.districts.length > 0) {
      console.log('\n   District prices:');
      data.districts.forEach((d, i) => {
        const changeStr = d.change !== null ? ` (${d.change > 0 ? '+' : ''}${d.change}%)` : '';
        console.log(`   ${i + 1}. ${d.name}: ${d.price.toLocaleString()} 元/平米${changeStr}`);
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
