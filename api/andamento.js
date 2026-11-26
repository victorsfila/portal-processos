// Função da Vercel: busca o andamento de cada processo no DataJud (CNJ) e,
// se houver GEMINI_API_KEY nas variáveis de ambiente da Vercel, resume com o Gemini.
// Só responde para quem está logado: a sessão é conferida no Apps Script da planilha.

const APPS_SCRIPT = 'https://script.google.com/macros/s/AKfycbzLz1EpViBa26WNoYC2eLWj6QhwcKEq-j70o-jHYsXJTsMz1sUV89ZNvTOB0F9itjbp/exec';
// Chave pública publicada pelo CNJ em datajud-wiki.cnj.jus.br/api-publica/acesso (pode ser trocada pela variável DATAJUD_KEY).
const DATAJUD_KEY = process.env.DATAJUD_KEY || 'cDZHYzlZa0JadVREZDJCendQbXY6SkJlTzNjLV9TRENyQk1RdnFKZGRQdw==';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
const CACHE_MS = 6 * 60 * 60 * 1000;
const cache = new Map();

const UFS = ['ac','al','ap','am','ba','ce','df','es','go','ma','mt','ms','mg','pa','pb','pr','pe','pi','rj','rn','rs','ro','rr','sc','se','sp','to'];
const digitos = s => String(s || '').replace(/\D/g, '');

function aliasTribunal(numero) {
  const d = digitos(numero);
  if (d.length !== 20) return null;
  const j = d.charAt(13), tr = Number(d.substr(14, 2));
  if (j === '8') return tr === 7 ? 'tjdft' : (UFS[tr - 1] ? 'tj' + UFS[tr - 1] : null);
  if (j === '6') return tr === 0 ? 'tse' : (UFS[tr - 1] ? 'tre-' + UFS[tr - 1] : null);
  if (j === '5') return tr === 0 ? 'tst' : 'trt' + tr;
  if (j === '4') return 'trf' + tr;
  if (j === '3') return 'stj';
  return null;
}

function textoMov(m) {
  const data = String(m.dataHora || '').slice(0, 10).split('-').reverse().join('/');
  const comp = (m.complementosTabelados || []).map(c => c.nome || c.descricao).filter(Boolean).join(', ');
  return data + ' – ' + (m.nome || 'Movimentação') + (comp ? ' (' + comp + ')' : '');
}

async function movimentos(numero) {
  const alias = aliasTribunal(numero);
  if (!alias) return { erro: true };
  const r = await fetch('https://api-publica.datajud.cnj.jus.br/api_publica_' + alias + '/_search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'APIKey ' + DATAJUD_KEY },
    body: JSON.stringify({ query: { match: { numeroProcesso: digitos(numero) } }, size: 10 })
  });
  if (!r.ok) return { erro: true };
  const hits = ((await r.json()).hits || {}).hits || [];
  const movs = [];
  hits.forEach(h => ((h._source || {}).movimentos || []).forEach(m => movs.push(m)));
  movs.sort((a, b) => String(b.dataHora).localeCompare(String(a.dataHora)));
  return { movs };
}

async function resumoGemini(p, movs) {
  const chave = process.env.GEMINI_API_KEY;
  if (!chave) return null;
  const prompt = 'Você vai explicar o andamento de um processo para uma pessoa comum, que não é advogada e não conhece nenhum termo jurídico. ' +
    'Ela já sabe do que o caso trata; quer entender o que aconteceu por último e o que deve acontecer agora.\n\n' +
    'Regras obrigatórias:\n' +
    '- Escreva em português do Brasil, como numa conversa simples por WhatsApp, em no máximo 3 frases curtas.\n' +
    '- NÃO use juridiquês nem termos técnicos. Nunca escreva palavras como: autos, conclusos, juntada, petição, contestação, réplica, citação, intimação, despacho, decisão interlocutória, sentença, trânsito em julgado, prazo decorrido, certidão, MPE, parecer, mero expediente, polo passivo, representada.\n' +
    '- Troque por palavras do dia a dia. Exemplos: "juntada de contestação" = "a defesa foi entregue"; "conclusos para decisão" = "o processo está com o juiz para ele decidir"; ' +
    '"citação" = "aviso oficial de que existe o processo"; "intimação" = "aviso oficial do tribunal"; "decorrido prazo" = "acabou o tempo para alguém se manifestar"; "sentença" = "a decisão do juiz".\n' +
    '- Não use siglas. Não cite números de processo, artigos de lei ou nomes de documentos.\n' +
    '- Não invente nada que não esteja nas movimentações. Se não der para saber o próximo passo, diga que é preciso aguardar.\n' +
    '- Responda só com o texto do resumo, sem título e sem marcadores.\n\n' +
    'Assunto do processo: ' + p.motivo + ' (' + p.area + ')\nÚltimas movimentações (mais recentes primeiro):\n' +
    movs.slice(0, 15).map(textoMov).join('\n');
  try {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': chave },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });
    if (!r.ok) return null;
    const j = await r.json();
    const partes = (((j.candidates || [])[0] || {}).content || {}).parts || [];
    return partes.map(x => x.text || '').join('').trim() || null;
  } catch (e) { return null; }
}

async function andamento(p) {
  const chave = digitos(p.num);
  const c = cache.get(chave);
  if (c && Date.now() - c.t < CACHE_MS) return c.v;
  let v;
  try {
    const r = await movimentos(p.num);
    if (r.erro) v = { tipo: 'erro', texto: 'Não foi possível consultar o andamento agora.' };
    else if (!r.movs.length) v = { tipo: 'vazio', texto: 'Andamento não disponível na consulta pública (processo sigiloso ou ainda não enviado pelo tribunal).' };
    else {
      const resumo = await resumoGemini(p, r.movs);
      v = {
        tipo: resumo ? 'resumo' : 'lista',
        texto: resumo || r.movs.slice(0, 3).map(textoMov).join('\n'),
        ultima: textoMov(r.movs[0]).split(' – ')[0]
      };
    }
  } catch (e) {
    v = { tipo: 'erro', texto: 'Não foi possível consultar o andamento agora.' };
  }
  if (v.tipo !== 'erro') cache.set(chave, { t: Date.now(), v });
  return v;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(); }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const token = body && body.token;
  if (!token) { res.statusCode = 401; return res.json({ erro: 'Sessão inválida.' }); }
  let d;
  try {
    const r = await fetch(APPS_SCRIPT, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ acao: 'atualizar', token })
    });
    d = await r.json();
  } catch (e) { res.statusCode = 502; return res.json({ erro: 'Planilha indisponível.' }); }
  if (!d || d.sessaoExpirada || d.erro) { res.statusCode = 401; return res.json({ erro: 'Sessão inválida.' }); }
  const out = {};
  await Promise.all((d.processos || []).map(async p => { out[p.num] = await andamento(p); }));
  res.json({ andamentos: out });
};
