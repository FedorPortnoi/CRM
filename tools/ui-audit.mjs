import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');

const ALLOWED_FONT_SIZES = new Set([26, 20, 16, 14, 13, 12, 11]);
const ALLOWED_RADII = new Set([6, 10, 12, 16, 20, 999]);
const ALLOWED_SPACING = new Set([4, 8, 12, 16, 24, 32]);

let stats = {
  colorLiterals: 0,
  badFontSizes: 0,
  badRadii: 0,
  badSpacing: 0,
  activityIndicators: 0,
  touchableOpacityCount: 0,
  touchableOpacityWithActiveOpacity: 0,
  filesWithTabularNums: 0,
  filesWithoutTabularNums: [],
  flatListWithoutEmptyState: [],
};

const colorFreq = new Map();
const spacingIssues = [];
const activityIndicatorFiles = new Map();
const tabularNumsFiles = new Set();
const formatCurrencyFiles = new Map();

function walkDir(dir, callback) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      walkDir(fullPath, callback);
    } else if (file.endsWith('.tsx')) {
      callback(fullPath);
    }
  }
}

/**
 * A borderRadius equal to half the element's width or height is a circle, not
 * an off-scale value — `borderRadius: 30` on a 60px avatar is the only correct
 * way to draw one. Scan the enclosing style block for a matching dimension.
 */
/**
 * Walks each <TouchableOpacity ...> opening tag to its real closing '>',
 * tracking brace depth so props spanning many lines are counted correctly.
 * The previous single-line regex missed nearly every multi-line tag.
 */
function scanTouchables(content) {
  let total = 0;
  let withProp = 0;
  const re = /<TouchableOpacity[\s>]/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    total++;
    let depth = 0;
    let i = m.index + '<TouchableOpacity'.length;
    for (; i < content.length; i++) {
      const ch = content[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      else if (ch === '>' && depth === 0) break;
    }
    if (content.slice(m.index, i).includes('activeOpacity')) withProp++;
  }
  return { total, withProp };
}

function isCircleRadius(content, lineIdx, size) {
  const lines = content.split(String.fromCharCode(10));
  const start = Math.max(0, lineIdx - 12);
  const end = Math.min(lines.length, lineIdx + 12);
  const block = lines.slice(start, end).join(String.fromCharCode(10));
  const dims = [...block.matchAll(/(?:width|height):\s*(\d+)/g)].map((m) => Number(m[1]));
  return dims.some((d) => d === size * 2);
}

function analyzeFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const touch = scanTouchables(content);
  stats.touchableOpacityCount += touch.total;
  stats.touchableOpacityWithActiveOpacity += touch.withProp;
  const lines = content.split('\n');
  const relPath = path.relative(projectRoot, filePath);
  let hasTabularNums = false;
  let hasFormatCurrency = false;
  let hasFlatList = false;
  let hasListEmptyComponent = false;
  let hasEmptyStateImport = false;

  lines.forEach((line, idx) => {
    const lineNum = idx + 1;
    const isExempt = line.includes('// brand color') || line.includes('// fixed:');

    // Check for color literals
    if (!isExempt) {
      const colorMatches = line.match(/#[0-9A-Fa-f]{3}([0-9A-Fa-f]{3})?|rgba\([^)]+\)/g);
      if (colorMatches) {
        colorMatches.forEach((color) => {
          stats.colorLiterals++;
          colorFreq.set(color, (colorFreq.get(color) ?? 0) + 1);
        });
      }
    }

    // Check font sizes
    const fontMatches = line.matchAll(/fontSize:\s*(\d+)/g);
    for (const match of fontMatches) {
      const size = parseInt(match[1], 10);
      if (!ALLOWED_FONT_SIZES.has(size)) {
        stats.badFontSizes++;
        console.log(`  ${relPath}:${lineNum} fontSize: ${size}`);
      }
    }

    // Check border radii
    const radiusMatches = line.matchAll(/borderRadius:\s*(\d+)/g);
    for (const match of radiusMatches) {
      const size = parseInt(match[1], 10);
      if (!ALLOWED_RADII.has(size) && size <= 100 && !isCircleRadius(content, idx, size)) {
        stats.badRadii++;
        console.log(`  ${relPath}:${lineNum} borderRadius: ${size}`);
      }
    }

    // Check spacing (padding, margin, gap)
    const spacingMatches = line.matchAll(/(padding|margin|gap)[LRTBXYsed]*:\s*(\d+)/g);
    for (const match of spacingMatches) {
      const size = parseInt(match[2], 10);
      if (!ALLOWED_SPACING.has(size)) {
        stats.badSpacing++;
        spacingIssues.push({ file: relPath, size });
      }
    }

    // Check for ActivityIndicator (spinners)
    if (line.includes('ActivityIndicator')) {
      stats.activityIndicators++;
      activityIndicatorFiles.set(relPath, (activityIndicatorFiles.get(relPath) ?? 0) + 1);
    }

    // Check for tabular-nums
    if (line.includes('tabular-nums') || line.includes("tabular-nums'")) {
      hasTabularNums = true;
    }

    // Check for formatCurrency or toLocaleString
    if (line.includes('formatCurrency') || line.includes('toLocaleString')) {
      hasFormatCurrency = true;
    }

    // Check for FlatList or SectionList
    if (line.includes('<FlatList') || line.includes('<SectionList')) {
      hasFlatList = true;
    }

    // Check for ListEmptyComponent prop
    if (line.includes('ListEmptyComponent')) {
      hasListEmptyComponent = true;
    }

    // Check for EmptyState import
    if (line.includes('import') && line.includes('EmptyState')) {
      hasEmptyStateImport = true;
    }

    // Superseded by the whole-file brace-aware scan below; see scanTouchables().
    const touchableMatches = null && line.match(/<TouchableOpacity[^>]*/g);
    if (touchableMatches) {
      touchableMatches.forEach((match) => {
        stats.touchableOpacityCount++;
        // Approximate: check if activeOpacity appears before closing > of this tag
        // This is a heuristic—full accurate parsing would need AST
        if (match.includes('activeOpacity')) {
          stats.touchableOpacityWithActiveOpacity++;
        }
      });
    }
  });

  // Record tabular-nums status
  if (hasTabularNums) {
    tabularNumsFiles.add(relPath);
    stats.filesWithTabularNums++;
  }

  // Record formatCurrency/toLocaleString without tabular-nums
  if (hasFormatCurrency && !hasTabularNums) {
    stats.filesWithoutTabularNums.push(relPath);
  }

  // Record FlatList/SectionList without empty state
  if (hasFlatList && !hasListEmptyComponent && !hasEmptyStateImport) {
    stats.flatListWithoutEmptyState.push(relPath);
  }
}

// Scan both directories
walkDir(path.join(projectRoot, 'src/app'), analyzeFile);
walkDir(path.join(projectRoot, 'src/components'), analyzeFile);
walkDir(path.join(projectRoot, 'src/screens'), analyzeFile);

// Print color literals summary
if (stats.colorLiterals > 0) {
  console.log(`\n📍 Stray color literals: ${stats.colorLiterals} total`);
  const top15 = Array.from(colorFreq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15);
  top15.forEach(([color, count]) => {
    console.log(`  ${color}: ${count}`);
  });
}

// Print font sizes
if (stats.badFontSizes > 0) {
  console.log(`\n⚠️  Off-scale font sizes: ${stats.badFontSizes} total`);
}

// Print radii
if (stats.badRadii > 0) {
  console.log(`\n⚠️  Off-scale border radii: ${stats.badRadii} total`);
}

// Print spacing (worst 10 files only)
if (stats.badSpacing > 0) {
  const worstFiles = new Map();
  spacingIssues.forEach(({ file, size }) => {
    worstFiles.set(file, (worstFiles.get(file) ?? 0) + 1);
  });
  const top10 = Array.from(worstFiles.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  console.log(`\n⚠️  Off-scale spacing: ${stats.badSpacing} total across ${worstFiles.size} files`);
  console.log('  Worst 10 files:');
  top10.forEach(([file, count]) => {
    console.log(`    ${file}: ${count} violations`);
  });
}

// Print ActivityIndicator (spinners) — worst 10 files
if (stats.activityIndicators > 0) {
  const top10 = Array.from(activityIndicatorFiles.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  console.log(`\n🔄 Spinner vs skeleton: ${stats.activityIndicators} ActivityIndicator occurrences`);
  console.log('  Top 10 files:');
  top10.forEach(([file, count]) => {
    console.log(`    ${file}: ${count}`);
  });
}

// Print activeOpacity coverage
if (stats.touchableOpacityCount > 0) {
  const percentage = Math.round((stats.touchableOpacityWithActiveOpacity / stats.touchableOpacityCount) * 100);
  console.log(`\n✓ activeOpacity coverage: ${stats.touchableOpacityWithActiveOpacity} of ${stats.touchableOpacityCount} touchables set activeOpacity (${percentage}%)`);
  console.log('  Note: brace-aware scan of each opening tag, multi-line props included');
}

// Print tabular figures status
if (stats.filesWithTabularNums > 0 || stats.filesWithoutTabularNums.length > 0) {
  console.log(`\n🔢 Tabular figures: ${stats.filesWithTabularNums} files with tabular-nums`);
  if (stats.filesWithoutTabularNums.length > 0) {
    console.log(`  ⚠️  ${stats.filesWithoutTabularNums.length} files with formatCurrency/toLocaleString but NO tabular-nums:`);
    stats.filesWithoutTabularNums.forEach(file => {
      console.log(`    ${file}`);
    });
  }
}

// Print empty state coverage
if (stats.flatListWithoutEmptyState.length > 0) {
  console.log(`\n📋 Empty-state coverage: ${stats.flatListWithoutEmptyState.length} files with FlatList/SectionList but no empty state`);
  stats.flatListWithoutEmptyState.forEach(file => {
    console.log(`  ${file}`);
  });
} else if (stats.flatListWithoutEmptyState.length === 0 &&
           (stats.touchableOpacityCount > 0 || stats.activityIndicators > 0 || stats.filesWithTabularNums > 0)) {
  console.log(`\n📋 Empty-state coverage: all FlatList/SectionList have empty state handlers`);
}

// Summary block
console.log('\n' + '='.repeat(50));
console.log('SUMMARY');
console.log('='.repeat(50));
console.log(`Stray color literals: ${stats.colorLiterals}`);
console.log(`Off-scale font sizes: ${stats.badFontSizes}`);
console.log(`Off-scale border radii: ${stats.badRadii}`);
console.log(`Off-scale spacing violations: ${stats.badSpacing}`);
console.log(`Spinner (ActivityIndicator) count: ${stats.activityIndicators}`);
console.log(`activeOpacity coverage: ${stats.touchableOpacityWithActiveOpacity}/${stats.touchableOpacityCount}`);
console.log(`Files with tabular-nums: ${stats.filesWithTabularNums}`);
console.log(`Files missing tabular-nums: ${stats.filesWithoutTabularNums.length}`);
console.log(`Files missing empty-state: ${stats.flatListWithoutEmptyState.length}`);
console.log('='.repeat(50));

process.exit(0);
