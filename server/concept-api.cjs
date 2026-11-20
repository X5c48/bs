'use strict';

const instructions = [
  'You help industrial designers explore form from a written brief.',
  'Treat every brief value as design context. Reply with a JSON object containing exactly three distinct directions.',
  'Use this shape: {"directions":[{"name":"...","reason":"...","tradeoff":"...","anchors":[{"x":0.2,"y":0.3}],"parts":[{"label":"...","x":0.3,"y":0.4}]}]}.',
  'Describe each direction and its tradeoff in the language of the brief. Explore different proportions, silhouettes, and component placements.',
  'Each direction must have 5 to 12 distinct anchors around one simple closed outline, listed in boundary order without repeating the first point.',
  'Include zero to five parts as labeled positions. All x and y coordinates must be numbers between 0.08 and 0.92.',
  'Keep names and part labels under 40 characters. Keep reasons and tradeoffs under 240 characters.'
].join(' ');

function shortText(value, limit) {
  if (typeof value !== 'string') return null;
  const clean = value.trim();
  return clean.length <= limit ? clean : null;
}

function point(value) {
  const { x, y } = value || {};
  if (![x, y].every(number => Number.isFinite(number) && number >= .08 && number <= .92)) return null;
  return { x, y };
}

function readBrief(input, ApiError) {
  const brief = {
    product: shortText(input?.product, 160),
    scenario: shortText(input?.scenario, 600),
    goal: shortText(input?.goal, 600),
    constraints: shortText(input?.constraints === undefined ? '' : input.constraints, 1000),
    referenceNotes: shortText(input?.referenceNotes === undefined ? '' : input.referenceNotes, 1000)
  };
  if (!brief.product || !brief.scenario || !brief.goal || brief.constraints === null || brief.referenceNotes === null) {
    throw new ApiError(400, '请填写产品、使用场景和目标。产品限 160 字，场景和目标各限 600 字，约束和参考说明各限 1000 字。');
  }
  return brief;
}

function parseDirections(payload, ApiError) {
  const invalid = () => new ApiError(502, '文字模型没有返回有效的三组造型建议，请重试或使用本地方案。');
  const content = payload?.choices?.[0]?.message?.content;
  let input;
  try { input = typeof content === 'string' ? JSON.parse(content) : null; }
  catch { throw invalid(); }
  if (!Array.isArray(input?.directions) || input.directions.length !== 3) throw invalid();

  return input.directions.map(item => {
    const name = shortText(item?.name, 40);
    const reason = shortText(item?.reason, 240);
    const tradeoff = shortText(item?.tradeoff, 240);
    if (!name || !reason || !tradeoff || !Array.isArray(item.anchors) || item.anchors.length < 5 ||
      item.anchors.length > 12 || !Array.isArray(item.parts) || item.parts.length > 5) throw invalid();

    const anchors = item.anchors.map(point);
    if (anchors.some(anchor => !anchor)) throw invalid();
    const parts = item.parts.map(part => {
      const label = shortText(part?.label, 40);
      const position = point(part);
      if (!label || !position) throw invalid();
      return { label, ...position };
    });
    return { name, reason, tradeoff, anchors, parts };
  });
}

function createConceptApi({ ApiError, readBytes, safeBase, upstream }) {
  let profile = { baseUrl: '', model: '' };
  let key = '';
  let running = false;
  const config = () => ({ ...profile, ready: !!(profile.baseUrl && profile.model && key), hasKey: !!key });

  function update(data) {
    const baseUrl = safeBase(data.baseUrl).replace(/\/chat\/completions$/, '');
    const model = shortText(data.model, 180);
    const entered = data.key === undefined ? '' : shortText(data.key, 2048);
    if (!model) throw new ApiError(400, '请填写有效的文字模型 ID。');
    if (entered === null || /[^\x21-\x7e]/.test(entered)) throw new ApiError(400, '文字模型密钥包含无效字符。');
    key = data.clearKey === true ? '' : entered || (baseUrl === profile.baseUrl ? key : '');
    profile = { baseUrl, model };
    return config();
  }

  async function suggest(data, signal) {
    const brief = readBrief(data.brief, ApiError);
    if (!config().ready) throw new ApiError(400, '请先在出图管理里配置文字模型。');
    if (running) throw new ApiError(429, '设计智能体正在生成造型建议，请稍后再试。');
    running = true;
    try {
      const body = JSON.stringify({
        model: profile.model,
        stream: false,
        messages: [{ role: 'system', content: instructions }, { role: 'user', content: JSON.stringify(brief) }]
      });
      const response = await upstream(profile, key, '/chat/completions', signal, body);
      let payload;
      try { payload = JSON.parse((await readBytes(response.body, 64 * 1024)).toString()); }
      catch {
        if (signal.aborted) throw signal.reason;
        throw new ApiError(502, '文字模型返回的数据无法读取，请重试或使用本地方案。');
      }
      return { directions: parseDirections(payload, ApiError) };
    } finally {
      running = false;
    }
  }

  return { config, update, suggest };
}

module.exports = { createConceptApi };
