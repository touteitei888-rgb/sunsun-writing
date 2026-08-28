#!/usr/bin/env node
/**
 * 文风体检 / style linter
 * 把一篇稿子与克制白描语料的实测基线做对比：硬红线命中 + 节奏偏差 + 首尾闭环。
 *
 *   node scripts/style_check.mjs draft.md
 *   node scripts/style_check.mjs draft.md --json
 *   node scripts/style_check.mjs --text "一张海报，300 dpi。"
 *
 * 只依赖 Node（>=18），不需要 Python 或第三方包。
 * 退出码：0 = 无硬红线；1 = 有硬红线；2 = 输入有问题。
 */

import fs from "node:fs";

/* ---------- 语料基线 ----------
 * 用本脚本自身的统计口径，在一份 6.5K 字的第一人称白描语料（272 段）上实测得出。
 * 改词表或改数字正则后必须重跑语料校准：node scripts/style_check.mjs <语料.txt>
 */
const BASELINE = {
  paraLenMedian: 15,
  shortParaRatio: 44.1, // ≤12 字段落占比 %
  sentLenMedian: 13,
  digitDensity: 2.45, // 每百字数字/量词标记数
  sayParaRatio: 30.1, // 以 我说/她说/我问 等开头的段落占比 %
  separatorsPerK: 0.77, // 每千字分节符数（5 个 / 6.4K 字）
  questionPerK: 0.77, // 每千字问号数（5 个 / 6.4K 字）
};

/* ---------- 硬红线词表 ---------- */
const LISTS = {
  情绪直陈: [
    "难过", "伤心", "开心", "高兴", "愤怒", "绝望", "幸福", "快乐", "痛苦", "心碎", "撕裂",
    "煎熬", "挣扎", "灵魂", "内心深处", "心底", "五味杂陈", "澎湃", "触动", "感动", "温暖",
    "孤独", "寂寞", "思念", "舍不得", "心疼", "心酸", "无奈", "感慨", "崩溃", "治愈",
    "破防", "泪目", "热泪盈眶", "泪流满面", "心如刀", "无法呼吸", "说不出话",
  ],
  抒情成语: [
    "物是人非", "白驹过隙", "历历在目", "岁月无恙", "涌上心头", "如潮水般", "如释重负", "未来可期", "时光荏苒", "岁月如歌",
    "刻骨铭心", "难以言表", "难以名状", "无法言喻", "说不出的", "莫名的", "沧海桑田",
    "恍如隔世", "记忆犹新", "情何以堪", "百感交集", "细水长流", "烟火气", "小确幸", "仪式感",
  ],
  AI套话: [
    "值得一提的是", "值得注意的是", "需要指出的是", "不难发现", "综上所述", "总的来说", "总体而言",
    "在当今", "随着时代", "不仅", "某种程度上", "某种意义上", "首先", "其次",
    "此外", "与此同时", "让我们一起", "赋能", "闭环", "抓手", "底层逻辑", "颗粒度",
    "堪称", "打造", "彰显", "诠释", "见证", "解锁", "拉满", "值得拥有", "极致", "匠心",
  ],
  元叙事: [
    "我想讲一个故事", "故事要从", "事情要从", "在那一刻", "那一刻我", "我忽然明白", "我终于明白",
    "我终于懂得", "这让我意识到", "让我意识到", "让我明白", "也许这就是", "或许这就是",
    "我想说的是", "写到这里", "回望", "感谢", "致敬", "希望你也",
  ],
  情感归因: [
    "我之所以", "因为我害怕", "我其实是", "我只是想", "我不过是想", "说到底我还是", "我终究还是",
    "我不是不难过", "我承认我", "我当然会", "人总要学会", "谁不是一边",
  ],
  替读者提问: [
    "你有没有想过", "想象一下", "你是否知道", "试着想想", "换成是你", "如果是你", "你想想", "你能体会",
  ],
};

const EMOTION_TARGET = /(心|感觉|空气|时间|命运|眼泪|泪|温暖|温柔|痛|爱|孤独|世界|生活|岁月|回忆|记忆|安静)/;
const MEANING_EXPLAIN = /(这代表|这象征|这意味着|代表着|象征着|说明了我|其实是在|本质上)/;

/* ---------- 工具 ---------- */
const chars = (s) => [...s.replace(/\s/g, "")];
const len = (s) => chars(s).length;
const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) / 2)] : 0);
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const pct = (a, b) => (b ? +((a / b) * 100).toFixed(1) : 0);

function toBlocks(raw) {
  let t = raw
    .replace(/```[\s\S]*?```/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  // 分节符：--- *** ——— 单独成行
  let separators = 0;
  t = t.replace(/^[ \t]*(?:-{2,}|\*{3,}|—{2,})[ \t]*$/gm, () => {
    separators++;
    return "\n@@SEP@@\n";
  });
  t = t.replace(/^[ \t]*[-*+][ \t]+/gm, "").replace(/^#{1,6}[ \t]+/gm, "");
  const parts = t
    .split(/\n\s*\n+/)
    .flatMap((b) => b.split(/@@SEP@@/))
    .map((b) => b.replace(/\s+/g, "").trim())
    .filter((b) => b.length > 0);
  return { blocks: parts.filter((b) => b !== ""), separators };
}

/* ---------- 主流程 ---------- */
export function analyze(raw) {
  const { blocks, separators } = toBlocks(raw);
  const all = blocks.join("");
  const total = len(all);

  const paraLens = blocks.map(len);
  const sents = blocks
    .flatMap((b) => b.split(/(?<=[。！？；])/))
    .map((s) => s.trim())
    .filter((s) => len(s) > 1);
  const sentLens = sents.map(len);

  const digitMarks = (all.match(/[0-9０-９]+|[一二三四五六七八九十百千万两]\s*(?:块|毛|分|年|月|日|号|点|秒|分钟|小时|天|次|个|人|张|卷|页|米|度|岁|美元|元|万|亿|克|吨)/g) || []).length;
  const sayParas = blocks.filter((b) => /^(我|她|他)(说|问|笑|沉默|没说话|摇头|点头|看着|听见|想)/.test(b)).length;
  const quoted = all.match(/[“"][^”"]{1,80}[”"]/g) || [];
  const questions = (all.match(/[？?]/g) || []).length;
  const exmarks = (all.match(/[！!]/g) || []).length;
  const ellipsis = (all.match(/…|\.\.\./g) || []).length;
  const dashes = (all.match(/—{1,2}/g) || []).length;
  const bolds = (raw.match(/\*\*[^*\n]+\*\*/g) || []).length;
  const headingLines = (raw.match(/^\s*#{1,6}\s+\S/gm) || []).length;
  const listLines = (raw.match(/^\s*[-*+]\s+\S/gm) || []).length;

  const digitDensity = total ? (digitMarks / total) * 100 : 0;
  const sepsPerK = total ? separators / (total / 1000) : 0;
  const qPerK = total ? (questions / total) * 1000 : 0;

  /* 红线命中 */
  const hits = [];
  const push = (kind, where, quote, why) => hits.push({ kind, where, quote: String(quote).slice(0, 60), why });

  const scanList = (label, words, advice) => {
    blocks.forEach((b, i) => {
      words.forEach((w) => {
        let idx = b.indexOf(w);
        while (idx !== -1) {
          push(label, `第${i + 1}段`, b.slice(Math.max(0, idx - 8), idx + w.length + 8), advice);
          idx = b.indexOf(w, idx + w.length);
        }
      });
    });
  };
  scanList("情绪直陈", LISTS.情绪直陈, "删掉情绪词，换一个动作、一个数字或一个物件");
  scanList("抒情成语", LISTS.抒情成语, "换成可观察的具体细节");
  scanList("AI套话", LISTS.AI套话, "删掉连接词和评价词，直接写事实");
  scanList("元叙事", LISTS.元叙事, "删掉总结句，让前文的事实自己承担意义");
  scanList("情感归因", LISTS.情感归因, "别替自己的动机找理由；只写她先做了什么、记下了哪个数");
  scanList("替读者提问", LISTS.替读者提问, "叙述者不拉着读者讨论，整句删");

  sents.forEach((s, i) => {
    const m = s.match(/(仿佛|好像|似乎|宛如|犹如|像是)[^。]{0,14}/);
    if (m && EMOTION_TARGET.test(m[0])) {
      push("情感比喻", `第${i + 1}句`, s, "比喻只用于可测量的物理观察（如“像体检单上的数字”），不用于情绪");
    }
    if (MEANING_EXPLAIN.test(s)) push("解释意义", `第${i + 1}句`, s, "禁止解释“这代表什么”，读者自己会懂");
  });

  if (exmarks) push("感叹号", "全文", `共 ${exmarks} 个`, "基线为 0，全部改成句号");
  if (ellipsis) push("省略号", "全文", `共 ${ellipsis} 个`, "基线为 0，用句号制造停顿");
  if (bolds) push("加粗强调", "全文", `共 ${bolds} 处`, "纯文本交付，不用 **加粗** 划重点");
  if (headingLines) push("小标题", "全文", `共 ${headingLines} 行`, "叙事稿不用 # 分节，用空行或 ---");
  if (listLines > 2) push("项目符号", "全文", `共 ${listLines} 行`, "叙事稿不列 bullet，改成短句分段");
  if (quoted.length > 6) push("引号对话", "全文", `共 ${quoted.length} 处`, "本文风几乎不用引号：写成 她说，周五交。那种转述");

  const runDetect = (arr, n, label, where, why) => {
    for (let i = 0; i + n - 1 < arr.length; i++) {
      const keys = arr.slice(i, i + n).map((x) => x.slice(0, 3));
      if (keys[0] && keys.every((k) => k === keys[0])) push(label, where, arr[i], why);
    }
  };
  runDetect(blocks, 3, "排比", "段落群", "三连同构=抒情节奏，拆掉其中两个，或让长度与句式各不相同");
  runDetect(sents, 4, "排比", "句子群", "连续四句同构，删到只剩最狠那一句");

  /* 节奏偏差 */
  const dev = [];
  const check = (label, got, want, tol, note, noteHigh) => {
    const ok = Math.abs(got - want) <= tol;
    dev.push({ label, got: +got.toFixed(2), want, ok, note: ok ? "" : got < want ? note : noteHigh || note });
  };
  if (total >= 200) {
    check("段长中位数", median(paraLens), BASELINE.paraLenMedian, 10, "多数段落只有一到两句");
    check("≤12字段落占比", pct(paraLens.filter((l) => l <= 12).length, paraLens.length), BASELINE.shortParaRatio, 22, "基线 44%：短段是节拍，长段只用来铺开一个场景");
    check("句长中位数", median(sentLens), BASELINE.sentLenMedian, 8, "基线 13 字");
  }
  check("数字密度/百字", digitDensity, BASELINE.digitDensity, 1.8, "基线 2.45：空泛的量词（很多、很久）换不成材料里的实数，就整句删掉", "数字过密，读起来像报表；留下最狠的几个，其余换成动作");
  check("分节符每千字", sepsPerK, BASELINE.separatorsPerK, 1.2, "基线 0.77：--- 只标阶段转折，不当段落分隔用", "--- 太密；把相邻的场景合回一段再走");
  if (total >= 400) {
    check("我说她说式段落占比", pct(sayParas, blocks.length), BASELINE.sayParaRatio, 15, "基线 30.1%：对话独立成段");
    check("问号每千字", qPerK, BASELINE.questionPerK, 1.3, "基线 0.77：多数追问被咽回去");
  }

  /* 首尾闭环：回扣开头（二字组重叠）或短促硬着陆，两种满足其一 */
  const first = blocks[0] || "";
  const last = blocks[blocks.length - 1] || "";
  const bigrams = (s) => {
    const a = chars(s);
    const set = new Set();
    for (let i = 0; i + 1 < a.length; i++) set.add(a[i] + a[i + 1]);
    return set;
  };
  const fbi = bigrams(first);
  let shared = 0;
  for (const g of bigrams(last)) if (fbi.has(g)) shared++;
  const landing = len(last) <= 16;
  const echo = {
    first,
    last,
    sharedBigrams: shared,
    shortLanding: landing,
    ok: total < 400 || shared >= 1 || landing,
    how: shared >= 1 ? "回扣开头" : landing ? "短促收束" : total < 400 ? "短稿不判定" : "两者都没有",
  };

  /* 评分 */
  let score = 100;
  const softHits = hits.filter((h) => !["感叹号", "省略号", "加粗强调", "小标题", "项目符号"].includes(h.kind));
  score -= Math.min(45, softHits.length * 4);
  score -= Math.min(10, exmarks * 2) + Math.min(8, ellipsis * 2) + Math.min(8, bolds) + Math.min(6, headingLines);
  dev.filter((d) => !d.ok).forEach(() => (score -= 3));
  if (!echo.ok && total > 400) score -= 2;
  score = Math.max(0, Math.round(score));

  return {
    score,
    stats: {
      字数: total,
      段落数: blocks.length,
      句数: sents.length,
      段长中位: median(paraLens),
      段长均值: +mean(paraLens).toFixed(1),
      最长段: paraLens.length ? Math.max(...paraLens) : 0,
      句长中位: median(sentLens),
      数字标记: digitMarks,
      数字密度每百字: +digitDensity.toFixed(2),
      分节符: separators,
      破折号: dashes,
      问号: questions,
      感叹号: exmarks,
      省略号: ellipsis,
      引号对话: quoted.length,
      加粗: bolds,
      小标题行: headingLines,
    },
    redlines: hits,
    rhythm: dev,
    echo,
  };
}

/* ---------- CLI ---------- */
const argv = process.argv.slice(2);
const jsonOnly = argv.includes("--json");
const tIdx = argv.indexOf("--text");
let input = "";

if (tIdx !== -1 && argv[tIdx + 1]) {
  input = argv[tIdx + 1];
} else {
  const file = argv.find((a) => !a.startsWith("--"));
  if (!file) {
    console.error("用法: node scripts/style_check.mjs <稿子.md|.txt> | --text \"正文\"");
    process.exit(2);
  }
  if (!fs.existsSync(file)) {
    console.error(`找不到文件：${file}`);
    process.exit(2);
  }
  input = fs.readFileSync(file, "utf8");
}

const r = analyze(input);

if (jsonOnly) {
  console.log(JSON.stringify(r, null, 2));
} else {
  const bar = "─".repeat(54);
  console.log(bar);
  console.log(`文风体检  ${r.score}/100   ${r.score >= 85 ? "可以交付" : r.score >= 70 ? "还需改一轮" : "AI 味偏重，建议重写"}`);
  console.log(bar);
  console.log("\n【指标】");
  Object.entries(r.stats).forEach(([k, v]) => console.log(`  ${k.padEnd(16, " ")}${v}`));
  console.log("\n【节奏 vs 基线】");
  r.rhythm.forEach((d) => console.log(`  ${d.ok ? "✓" : "✗"} ${d.label}：实测 ${d.got}（基线 ${d.want}）${d.ok ? "" : "— " + d.note}`));
  console.log("\n【硬红线】" + (r.redlines.length ? ` ${r.redlines.length} 处` : " 0 处"));
  r.redlines.slice(0, 40).forEach((h, i) => console.log(`  ${i + 1}. [${h.kind}] ${h.where}｜…${h.quote}…\n     → ${h.why}`));
  if (r.redlines.length > 40) console.log(`  …另有 ${r.redlines.length - 40} 处，用 --json 看全量`);
  console.log("\n【首尾闭环】");
  console.log(`  首段：${r.echo.first.slice(0, 42)}`);
  console.log(`  末段：${r.echo.last.slice(0, 42)}（${len(r.echo.last)} 字）`);
  console.log(`  共用二字组：${r.echo.sharedBigrams}  末段${r.echo.shortLanding ? "≤16 字硬着陆" : "偏长"}  ${r.echo.ok ? "✓ " + r.echo.how : "✗ 结尾既没回扣开头也没短促收束"}`);
  console.log(bar);
}
process.exit(r.redlines.length ? 1 : 0);
