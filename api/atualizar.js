// Tarefa diária (Vercel Cron): consulta as publicações oficiais (DJEN/CNJ), um processo por vez,
// resume com o Gemini (se houver GEMINI_API_KEY) e grava o resultado na planilha.
// O site só lê o que ficou gravado na planilha.
// Precisa da variável CRON_SECRET na Vercel (o mesmo segredo que está no Apps Script).

const APPS_SCRIPT = 'https://script.google.com/macros/s/AKfycbzLz1EpViBa26WNoYC2eLWj6QhwcKEq-j70o-jHYsXJTsMz1sUV89ZNvTOB0F9itjbp/exec';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
const PAUSA_MS = 4000;          // espera entre um processo e outro
const LIMITE_TOTAL_MS = 270000; // para antes do tempo máximo da função

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

// Publicações oficiais do processo no Diário de Justiça Eletrônico Nacional (DJEN/CNJ): gratuito e sem chave.
async function comunicacoes(numero) {
  const url = 'https://comunicaapi.pje.jus.br/api/v1/comunicacao?numeroProcesso=' + digitos(numero);
  for (let tentativa = 1; tentativa <= 2; tentativa++) {
    let r;
    try { r = await buscar(url, { headers: { Accept: 'application/json' } }, 20000); }
    catch (e) { if (tentativa === 2) return { erro: 'tempo' }; await dormir(8000); continue; }
    if (r.status === 429) { if (tentativa === 2) return { erro: '429' }; await dormir(15000); continue; }
    if (!r.ok) return { erro: String(r.status) };
    const itens = ((await r.json()).items || []).filter(i => i.ativo !== false);
    itens.sort((x, y) => String(y.data_disponibilizacao).localeCompare(String(x.data_disponibilizacao)));
    return { itens };
  }
  return { erro: 'desconhecido' };
}

function limparHtml(h) {
  return String(h || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|tr|section|div|br)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&([a-zA-Z])(acute|grave|circ|tilde|cedil|uml);/g, (m, l, t) => ({ acute: { a: 'á', e: 'é', i: 'í', o: 'ó', u: 'ú', A: 'Á', E: 'É', I: 'Í', O: 'Ó', U: 'Ú' }, grave: { a: 'à', A: 'À' }, circ: { a: 'â', e: 'ê', o: 'ô', A: 'Â', E: 'Ê', O: 'Ô' }, tilde: { a: 'ã', o: 'õ', A: 'Ã', O: 'Õ' }, cedil: { c: 'ç', C: 'Ç' }, uml: { u: 'ü' } }[t] || {})[l] || m)
    .replace(/&ordm;/g, 'º').replace(/&ordf;/g, 'ª').replace(/&sect;/g, '§').replace(/&ndash;/g, '–')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

function dataBr(iso) { const p = String(iso || '').slice(0, 10).split('-'); return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : ''; }
function textoCom(i) { return dataBr(i.data_disponibilizacao) + ' – ' + (i.tipoDocumento || i.tipoComunicacao || 'Publicação'); }

async function resumoGemini(p, itens) {
  const chave = process.env.GEMINI_API_KEY;
  if (!chave) return null;
  const pubs = itens.slice(0, 4).map(i => '### ' + textoCom(i) + '\n' + limparHtml(i.texto).slice(0, 2500)).join('\n\n');
  const prompt = 'Você vai explicar o andamento de um processo para uma pessoa comum, que não é advogada e não conhece nenhum termo jurídico. ' +
    'Ela já sabe do que o caso trata; quer entender o que aconteceu por último e o que deve acontecer agora. Ela é uma das partes do processo.\n\n' +
    'Regras obrigatórias:\n' +
    '- Escreva em português do Brasil, como numa conversa simples por WhatsApp, em no máximo 3 frases curtas.\n' +
    '- Comece pelo acontecimento mais recente. Se houve uma decisão do juiz, diga claramente se foi a favor ou contra ela.\n' +
    '- NÃO use juridiquês nem termos técnicos. Nunca escreva palavras como: autos, conclusos, juntada, petição, contestação, réplica, citação, intimação, despacho, decisão interlocutória, sentença, improcedente, procedente, sucumbência, trânsito em julgado, prazo decorrido, certidão, ato ordinatório, tutela, MPE, parecer, polo passivo, representada.\n' +
    '- Troque por palavras do dia a dia. Exemplos: "julgo improcedentes os pedidos" contra ela = "o juiz decidiu a seu favor e rejeitou o que pediam contra você"; ' +
    '"condeno ao pagamento de honorários" = "quem perdeu vai ter que pagar os custos e os advogados"; "cite-se" = "a outra parte vai ser avisada oficialmente"; "conclusos" = "o processo está com o juiz para ele decidir".\n' +
    '- Não use siglas. Não cite números de processo, artigos de lei, valores percentuais ou nomes de documentos.\n' +
    '- Não invente nada que não esteja nas publicações. Se não der para saber o próximo passo, diga que é preciso aguardar.\n' +
    '- Responda só com o texto do resumo, sem título e sem marcadores.\n\n' +
    'Assunto do processo: ' + p.motivo + ' (' + p.area + ')\n' +
    'Últimas publicações oficiais do processo (mais recentes primeiro):\n\n' + pubs;
  try {
    const r = await buscar('https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': chave },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    }, 30000);
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
    // Justiça Eleitoral (J = 6) não publica no DJEN: o resumo desses é atualizado à mão e não pode ser apagado aqui
    if (digitos(p.num).charAt(13) === '6') { resultado.pulados++; continue; }
    const r = await comunicacoes(p.num);
    let texto = null;
    if (r.erro) { resultado.falhas++; }
    else if (!r.itens.length) {
      // Justiça Eleitoral (J = 6) não publica no DJEN; criminal antes da citação costuma não ter publicação
      texto = digitos(p.num).charAt(13) === '6'
        ? 'Processo da Justiça Eleitoral: o andamento dele não aparece no diário oficial nacional, então acompanhe pelas observações do advogado.'
        : 'Ainda não saiu nenhuma publicação oficial neste processo. Isso é normal no começo do processo; o advogado acompanha por aqui.';
      resultado.semDados++;
    }
    else { texto = (await resumoGemini(p, r.itens)) || r.itens.slice(0, 3).map(textoCom).join('\n'); resultado.ok++; }
    if (texto) await planilha({ acao: 'salvar', itens: [{ num: p.num, texto }] });
    await dormir(PAUSA_MS);
  }
  console.log('[atualizar] fim', JSON.stringify(resultado), (Date.now() - inicio) + 'ms');
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(resultado));
};
