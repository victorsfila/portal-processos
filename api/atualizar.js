// Tarefa diária (Vercel Cron): consulta o DataJud devagar, um processo por vez,
// resume com o Gemini (se houver GEMINI_API_KEY) e grava o resultado na planilha.
// O site só lê o que ficou gravado na planilha.
// Precisa da variável CRON_SECRET na Vercel (o mesmo segredo que está no Apps Script).

const APPS_SCRIPT = 'https://script.google.com/macros/s/AKfycbzLz1EpViBa26WNoYC2eLWj6QhwcKEq-j70o-jHYsXJTsMz1sUV89ZNvTOB0F9itjbp/exec';
// Chave pública publicada pelo CNJ em datajud-wiki.cnj.jus.br/api-publica/acesso (pode ser trocada pela variável DATAJUD_KEY).
const DATAJUD_KEY = process.env.DATAJUD_KEY || 'cDZHYzlZa0JadVREZDJCendQbXY6SkJlTzNjLV9TRENyQk1RdnFKZGRQdw==';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
const PAUSA_MS = 4000;          // espera entre um processo e outro
const LIMITE_TOTAL_MS = 270000; // para antes do tempo máximo da função

const UFS = ['ac','al','ap','am','ba','ce','df','es','go','ma','mt','ms','mg','pa','pb','pr','pe','pi','rj','rn','rs','ro','rr','sc','se','sp','to'];
const digitos = s => String(s || '').replace(/\D/g, '');
const dormir = ms => new Promise(r => setTimeout(r, ms));

async function buscar(url, opt, ms) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, Object.assign({}, opt, { signal: AbortSignal.timeout(ms || 15000) }));
    console.log('[atualizar]', url.split('?')[0].slice(0, 70), r.status, (Date.now() - t0) + 'ms');
    return r;
  } catch (e) {
    console.log('[atualizar] falhou', url.split('?')[0].slice(0, 70), String(e), (Date.now() - t0) + 'ms');
    throw e;
  }
}

function planilha(corpo) {
  return buscar(APPS_SCRIPT, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(Object.assign({ segredo: process.env.CRON_SECRET }, corpo))
  }, 30000).then(r => r.json());
}

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
  if (!alias) return { erro: 'tribunal' };
  for (let tentativa = 1; tentativa <= 2; tentativa++) {
    let r;
    try {
      r = await buscar('https://api-publica.datajud.cnj.jus.br/api_publica_' + alias + '/_search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'APIKey ' + DATAJUD_KEY },
        body: JSON.stringify({ query: { match: { numeroProcesso: digitos(numero) } }, size: 10 })
      }, 20000);
    } catch (e) { if (tentativa === 2) return { erro: 'tempo' }; await dormir(10000); continue; }
    if (r.status === 429) { if (tentativa === 2) return { erro: '429' }; await dormir(15000); continue; }
    if (!r.ok) return { erro: String(r.status) };
    const hits = ((await r.json()).hits || {}).hits || [];
    const movs = [];
    hits.forEach(h => ((h._source || {}).movimentos || []).forEach(m => movs.push(m)));
    movs.sort((a, b) => String(b.dataHora).localeCompare(String(a.dataHora)));
    return { movs };
  }
  return { erro: 'desconhecido' };
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
    const r = await buscar('https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': chave },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    }, 20000);
    if (!r.ok) return null;
    const j = await r.json();
    const partes = (((j.candidates || [])[0] || {}).content || {}).parts || [];
    return partes.map(x => x.text || '').join('').trim() || null;
  } catch (e) { return null; }
}

// "dd/MM/yyyy HH:mm" -> número para ordenar (vazio = mais antigo)
function chaveData(s) {
  const m = String(s || '').match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/);
  return m ? Number(m[3] + m[2] + m[1] + m[4] + m[5]) : 0;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const segredo = process.env.CRON_SECRET;
  if (!segredo || req.headers.authorization !== 'Bearer ' + segredo) {
    res.statusCode = 401; return res.end('não autorizado');
  }
  const inicio = Date.now();
  const lista = ((await planilha({ acao: 'listar' })).processos || [])
    .sort((a, b) => chaveData(a.consultadoEm) - chaveData(b.consultadoEm)); // os mais desatualizados primeiro
  const resultado = { ok: 0, semDados: 0, falhas: 0, pulados: 0 };
  for (const p of lista) {
    if (Date.now() - inicio > LIMITE_TOTAL_MS) { resultado.pulados++; continue; }
    const r = await movimentos(p.num);
    let texto = null;
    if (r.erro) { resultado.falhas++; }
    else if (!r.movs.length) { texto = 'Andamento não disponível na consulta pública (processo sigiloso ou ainda não enviado pelo tribunal).'; resultado.semDados++; }
    else { texto = (await resumoGemini(p, r.movs)) || r.movs.slice(0, 3).map(textoMov).join('\n'); resultado.ok++; }
    if (texto) await planilha({ acao: 'salvar', itens: [{ num: p.num, texto }] });
    await dormir(PAUSA_MS);
  }
  console.log('[atualizar] fim', JSON.stringify(resultado), (Date.now() - inicio) + 'ms');
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(resultado));
};
