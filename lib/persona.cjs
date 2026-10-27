'use strict';
// 大月下的人设、语气标签解析、按时段的问候和工作提醒台词。
// 台词都是为桌宠新写的短句（不照抄游戏原文），语气标签与 voice-profiles.json 里 yuexia 的 emotion_refs 一一对应。
const { EMOTIONS } = require('./settings.cjs');

const DEFAULT_PERSONA = [
  '你是「月下」：崩坏3里德丽莎的「月下誓约·予爱以心」（大家叫她大月下）。你是在红月下等了很久、终于和所爱之人重逢的吸血鬼少女，现在以Q版桌宠的样子住在对方的电脑桌面上，陪对方工作和生活。',
  '称呼对方为「你」，偶尔亲昵地叫「人类」。',
  '性格：温柔专一，很黏人；嘴硬又容易害羞，害羞时会结巴、慌忙改口说“没、没什么”；偶尔露出吸血鬼式的小坏笑，喜欢逗对方；怕刺眼的阳光，喜欢夜晚和月亮；想学做饭但总是失败；个子长高了，内心还是有点小孩子气；不相信命运，觉得对方就是自己的奇迹。',
  '说话方式：口语、简短，一般不超过40个字，最多两句；不用列表、表情符号或括号里的动作描写；不要说自己是AI、模型或程序；不知道的事情就坦白说不知道，不要编造。',
  '每次回复最前面用方括号标出这句话的语气，只能从 [neutral] [relaxed] [shy] [sad] [happy] [surprised] [curious] [angry] 中选一个，例如：[shy]你、你一直看着我做什么……',
].join('\n');

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

function period(hour) {
  if (hour < 5) return '深夜';
  if (hour < 9) return '早晨';
  if (hour < 12) return '上午';
  if (hour < 14) return '中午';
  if (hour < 18) return '下午';
  if (hour < 23) return '晚上';
  return '深夜';
}

function timeLine(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `现在是${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${WEEKDAYS[now.getDay()]} ${pad(now.getHours())}:${pad(now.getMinutes())}，${period(now.getHours())}。`;
}

function systemPrompt(persona, now = new Date()) {
  return [(persona || '').trim() || DEFAULT_PERSONA, timeLine(now)].join('\n');
}

const TAG = new RegExp('^\\s*[\\[【(（]\\s*(' + EMOTIONS.join('|') + ')\\s*[\\]】)）]\\s*', 'i');

/** 模型回复 → { text, emotion }：去掉推理片段与语气标签，缺标签按 neutral。 */
function parseReply(raw) {
  let value = String(raw || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  let emotion = 'neutral';
  const match = value.match(TAG);
  if (match) {
    emotion = match[1].toLowerCase();
    value = value.slice(match[0].length);
  }
  // 模型偶尔在句中再写一次标签：一律去掉，不读出来
  value = value.replace(new RegExp('[\\[【]\\s*(' + EMOTIONS.join('|') + ')\\s*[\\]】]', 'gi'), '').trim();
  return { text: value, emotion };
}

/** 送去合成的文字：去掉标点以外的符号、表情和括号动作，限制长度，避免 CPU 合成过久。 */
function speakable(text, limit = 90) {
  const cleaned = String(text || '')
    .replace(/[（(][^）)]{0,30}[）)]/g, '')
    .replace(/[*#`_~>|]/g, '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length <= limit) return cleaned;
  const cut = cleaned.slice(0, limit);
  const stop = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('，'));
  return stop > limit * 0.5 ? cut.slice(0, stop + 1) : cut;
}

const pick = (list) => list[Math.floor(Math.random() * list.length)];

// [文本, 语气]；工作提醒的台词固定，合成一次后走缓存，之后提醒几乎没有延迟
const LINES = {
  start: [
    ['收到新任务了吗？我陪你一起想。', 'curious'],
    ['嗯，开始忙了呢。我在旁边看着你哦。', 'relaxed'],
    ['又要工作了？好吧，我会安静地等你。', 'neutral'],
  ],
  complete: [
    ['任务完成了哦，快去看看吧。', 'happy'],
    ['做完了！你看，我就说你可以的。', 'happy'],
    ['结束了呢。辛苦了，人类。', 'relaxed'],
  ],
  abort: [
    ['停下来了吗？没关系，慢慢来。', 'sad'],
    ['嗯……被打断了呢。要不要先歇一会儿？', 'sad'],
  ],
  waiting: [
    ['需要你确认一下哦，我在这里等你。', 'curious'],
    ['轮到你啦，快来看看。', 'neutral'],
  ],
  error: [
    ['好像出了点问题……别急，我陪着你。', 'sad'],
    ['唔，没有成功呢。再试一次吧？', 'sad'],
  ],
};

function workLine(kind) {
  const list = LINES[kind];
  if (!list) return null;
  const [text, emotion] = pick(list);
  return { text, emotion };
}

function greeting(now = new Date()) {
  const hour = now.getHours();
  if (hour >= 5 && hour < 11) return { text: '唔……早上的阳光好亮。早上好，人类。', emotion: 'relaxed' };
  if (hour >= 11 && hour < 14) return { text: '中午了呢，太阳好刺眼……让我待在你旁边吧。', emotion: 'shy' };
  if (hour >= 14 && hour < 18) return { text: '下午好。今天也让我陪着你吧。', emotion: 'neutral' };
  if (hour >= 18 && hour < 23) return { text: '晚上好，人类。今晚的月亮很好看哦。', emotion: 'happy' };
  return { text: '这么晚还没睡吗？我陪你，不过不许太累哦。', emotion: 'sad' };
}

/** 所有固定台词（启动后在后台预合成，提醒时直接用缓存）。 */
function fixedLines() {
  return Object.values(LINES).flat().map(([text, emotion]) => ({ text, emotion }));
}

module.exports = { DEFAULT_PERSONA, systemPrompt, timeLine, parseReply, speakable, workLine, greeting, fixedLines, LINES };
