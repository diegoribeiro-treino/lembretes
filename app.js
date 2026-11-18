'use strict';
/* Porta-comprimidos — lembretes de remédios e suplementos.
   Os dados ficam no aparelho (localStorage) e, quando conectado, num Gist secreto do GitHub.
   O Calendário do iPhone assina o arquivo .ics desse Gist; "Confirmar" reescreve o arquivo. */

const ARQ_DADOS = 'lembretes-dados.json';
const ARQ_ICS = 'Lembretes.ics';
const K = { dados: 'lembretes:dados', base: 'lembretes:confirmado', token: 'lembretes:token', gist: 'lembretes:gist', marcas: 'lembretes:marcas', aba: 'lembretes:aba' };
const ls = {
  get(k, def) { try { const v = localStorage.getItem(k); return v == null ? def : JSON.parse(v); } catch (e) { return def; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} },
};

/* ---------- datas ---------- */
const pad = n => String(n).padStart(2, '0');
const iso = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const soma = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
const dif = (a, b) => Math.round((parse(b) - parse(a)) / 864e5);
const hojeISO = () => iso(new Date());
const br = s => s ? parse(s).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) : '';
const brLongo = s => parse(s).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const novoId = () => Math.random().toString(36).slice(2, 10);

/* ---------- estado ---------- */
const VAZIO = { versao: 1, antecedencia: 7, horaAvisoEstoque: '10:00', itens: [] };
let dados = ls.get(K.dados, null);
let base = ls.get(K.base, null);          // JSON da última versão confirmada
let aba = ls.get(K.aba, 'hoje');
let editando = null;                      // cópia do item em edição
let gistInfo = ls.get(K.gist, null);      // { id, owner }
const token = () => ls.get(K.token, '');

function normalizar(d) {
  d = Object.assign({}, VAZIO, d || {});
  d.itens = (d.itens || []).map(i => Object.assign({ id: novoId(), nome: '', dose: '', obs: '', ativo: true, estoque: null, horarios: [] }, i));
  return d;
}
dados = normalizar(dados);
const salvarLocal = () => ls.set(K.dados, dados);
const pendente = () => base !== JSON.stringify(dados);

/* ---------- regras ---------- */
const ativoEm = (h, dia) => (!h.inicio || h.inicio <= dia) && (!h.fim || dia <= h.fim);
const consumoDia = (item, dia) => item.ativo === false ? 0 :
  item.horarios.filter(h => ativoEm(h, dia)).reduce((a, h) => a + (Number(h.qtd) || 0), 0);

// Simula o estoque dia a dia a partir da data da contagem.
function previsao(item) {
  const e = item.estoque;
  if (!e || e.doses === '' || e.doses == null || isNaN(Number(e.doses))) return null;
  const hoje = hojeISO();
  let resto = Number(e.doses), dia = e.em || hoje, restoHoje = dia > hoje ? resto : null;
  for (let i = 0; i < 2000; i++) {
    if (dia === hoje) restoHoje = resto;
    const c = consumoDia(item, dia);
    if (c > 0 && resto < c) return { fim: dia, resto: restoHoje == null ? Math.max(0, resto) : restoHoje };
    resto -= c; dia = soma(dia, 1);
  }
  return { fim: null, resto: restoHoje == null ? resto : restoHoje };
}

function alertasEstoque() {
  const hoje = hojeISO(), out = [];
  dados.itens.forEach(item => {
    if (item.ativo === false) return;
    const p = previsao(item); if (!p || !p.fim) return;
    const faltam = dif(hoje, p.fim);
    if (faltam <= dados.antecedencia) out.push({ item, fim: p.fim, faltam, resto: p.resto });
  });
  return out.sort((a, b) => a.faltam - b.faltam);
}

function doseTxt(item, qtd) {
  const q = Number(qtd) || 1;
  return (q !== 1 ? q + ' × ' : '') + (item.dose || '1 dose');
}

// Horários do dia agrupados por hora.
function planoDoDia(dia) {
  const por = {};
  dados.itens.forEach(item => {
    if (item.ativo === false) return;
    item.horarios.forEach(h => { if (h.hora && ativoEm(h, dia)) (por[h.hora] = por[h.hora] || []).push({ item, h }); });
  });
  return Object.keys(por).sort().map(hora => ({ hora, itens: por[hora] }));
}

/* ---------- calendário (.ics) ---------- */
function icsTxt(s) { return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n'); }
function dobra(linha) {
  const out = []; let atual = '', bytes = 0;
  for (const ch of linha) {
    const b = new TextEncoder().encode(ch).length;
    if (bytes + b > (out.length ? 74 : 75)) { out.push(atual); atual = ''; bytes = 0; }
    atual += ch; bytes += b;
  }
  out.push(atual); return out.join('\r\n ');
}
const ymd = s => s.replace(/-/g, '');
const hm = h => h.replace(':', '') + '00';
const maisMin = (hora, m) => { const [a, b] = hora.split(':').map(Number); const t = a * 60 + b + m; return pad(Math.floor(t / 60) % 24) + ':' + pad(t % 60); };
function hash(s) { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }

function gerarICS() {
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Porta-comprimidos//PT-BR', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:Remédios', 'X-WR-TIMEZONE:America/Sao_Paulo', 'REFRESH-INTERVAL;VALUE=DURATION:PT15M', 'X-PUBLISHED-TTL:PT15M',
    'BEGIN:VTIMEZONE', 'TZID:America/Sao_Paulo', 'BEGIN:STANDARD', 'DTSTART:19700101T000000', 'TZOFFSETFROM:-0300', 'TZOFFSETTO:-0300', 'TZNAME:-03', 'END:STANDARD', 'END:VTIMEZONE'];
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const ev = (uid, dia, hora, dur, titulo, desc, rrule) => {
    L.push('BEGIN:VEVENT', 'UID:' + uid + '@porta-comprimidos', 'DTSTAMP:' + stamp,
      'DTSTART;TZID=America/Sao_Paulo:' + ymd(dia) + 'T' + hm(hora),
      'DTEND;TZID=America/Sao_Paulo:' + ymd(dia) + 'T' + hm(maisMin(hora, dur)));
    if (rrule) L.push(rrule);
    L.push(dobra('SUMMARY:' + icsTxt(titulo)), dobra('DESCRIPTION:' + icsTxt(desc)), 'TRANSP:TRANSPARENT',
      'BEGIN:VALARM', 'ACTION:DISPLAY', dobra('DESCRIPTION:' + icsTxt(titulo)), 'TRIGGER:PT0M', 'END:VALARM', 'END:VEVENT');
  };

  // Lembretes de dose: por horário, em trechos de datas com o mesmo conjunto de itens.
  const porHora = {};
  dados.itens.forEach(item => { if (item.ativo !== false) item.horarios.forEach(h => { if (h.hora) (porHora[h.hora] = porHora[h.hora] || []).push({ item, h }); }); });
  const hoje = hojeISO();
  Object.keys(porHora).sort().forEach(hora => {
    const lista = porHora[hora];
    const cortes = new Set();
    lista.forEach(({ h }) => { cortes.add(h.inicio || hoje); if (h.fim) cortes.add(soma(h.fim, 1)); });
    const pts = [...cortes].sort();
    pts.forEach((ini, i) => {
      const fimTrecho = pts[i + 1] ? soma(pts[i + 1], -1) : null;
      const ativos = lista.filter(({ h }) => ativoEm(Object.assign({}, h, { inicio: h.inicio || hoje }), ini));
      if (!ativos.length) return;
      const titulo = '💊 ' + ativos.map(({ item, h }) => item.nome + (Number(h.qtd) !== 1 ? ' ×' + h.qtd : '')).join(' + ');
      const desc = ativos.map(({ item, h }) => '• ' + item.nome + ': ' + doseTxt(item, h.qtd) + (item.obs ? ' — ' + item.obs : '')).join('\n');
      const rr = 'RRULE:FREQ=DAILY' + (fimTrecho ? ';COUNT=' + (dif(ini, fimTrecho) + 1) : '');
      ev('dose-' + hash(hora + ini), ini, hora, 10, titulo, desc, rr);
    });
  });

  // Avisos de estoque: N dias antes de acabar e no dia em que acaba.
  dados.itens.forEach(item => {
    if (item.ativo === false) return;
    const p = previsao(item); if (!p || !p.fim) return;
    const aviso = soma(p.fim, -dados.antecedencia);
    const dAviso = aviso < hoje ? hoje : aviso;
    ev('estoque-' + hash(item.id + p.fim), dAviso, dados.horaAvisoEstoque || '10:00', 15,
      '⚠️ ' + item.nome + ' acaba em ' + brLongo(p.fim),
      'Pelo estoque cadastrado, ' + item.nome + ' acaba em ' + brLongo(p.fim) + '. Hora de comprar mais. Depois, atualize o estoque no app e toque em Confirmar.');
    if (p.fim > hoje) ev('acabou-' + hash(item.id + p.fim), p.fim, dados.horaAvisoEstoque || '10:00', 15,
      '⛔ ' + item.nome + ' acabou hoje', 'Pelo estoque cadastrado, hoje não há doses suficientes de ' + item.nome + '.');
  });
  L.push('END:VCALENDAR');
  return L.join('\r\n') + '\r\n';
}

/* ---------- GitHub Gist ---------- */
async function gh(caminho, opts = {}) {
  const r = await fetch('https://api.github.com' + caminho, Object.assign({}, opts, {
    headers: Object.assign({ 'Accept': 'application/vnd.github+json', 'Authorization': 'Bearer ' + token(), 'X-GitHub-Api-Version': '2022-11-28' }, opts.headers || {}),
    cache: 'no-store',
  }));
  if (r.status === 401) throw new Error('O token do GitHub não foi aceito. Gere outro em Ajustes.');
  if (!r.ok) throw new Error('GitHub respondeu ' + r.status + '. Tente de novo em instantes.');
  return r.json();
}
async function acharGist() {
  for (let pg = 1; pg <= 5; pg++) {
    const lista = await gh('/gists?per_page=100&page=' + pg);
    const g = lista.find(x => x.files && x.files[ARQ_DADOS]);
    if (g) return { id: g.id, owner: g.owner.login };
    if (lista.length < 100) break;
  }
  return null;
}
async function baixarDoGist() {
  if (!gistInfo) gistInfo = await acharGist();
  if (!gistInfo) return false;
  ls.set(K.gist, gistInfo);
  const g = await gh('/gists/' + gistInfo.id);
  const f = g.files[ARQ_DADOS];
  let txt = f.content;
  if (f.truncated) txt = await (await fetch(f.raw_url, { cache: 'no-store' })).text();
  dados = normalizar(JSON.parse(txt));
  base = JSON.stringify(dados);
  salvarLocal(); ls.set(K.base, base);
  return true;
}
async function confirmar() {
  const btn = document.getElementById('btn-confirmar');
  dados.atualizado = new Date().toISOString();
  const files = { [ARQ_DADOS]: { content: JSON.stringify(dados, null, 2) }, [ARQ_ICS]: { content: gerarICS() } };
  if (!token()) { toast('Conecte o GitHub em Ajustes para enviar ao Calendário.'); irPara('ajustes'); return; }
  btn.disabled = true; btn.textContent = 'Enviando…';
  try {
    if (!gistInfo) gistInfo = await acharGist();
    if (gistInfo) await gh('/gists/' + gistInfo.id, { method: 'PATCH', body: JSON.stringify({ files }) });
    else {
      const g = await gh('/gists', { method: 'POST', body: JSON.stringify({ description: 'Porta-comprimidos (lembretes)', public: false, files }) });
      gistInfo = { id: g.id, owner: g.owner.login };
    }
    ls.set(K.gist, gistInfo);
    base = JSON.stringify(dados); ls.set(K.base, base); salvarLocal();
    toast('Enviado. O iPhone atualiza o Calendário em alguns minutos.');
  } catch (e) { toast(e.message || 'Não foi possível enviar. Verifique a internet.'); }
  btn.disabled = false; btn.textContent = 'Confirmar';
  render();
}
const linkAssinatura = () => gistInfo ? 'webcal://gist.githubusercontent.com/' + gistInfo.owner + '/' + gistInfo.id + '/raw/' + ARQ_ICS : '';

/* ---------- interface ---------- */
const $app = document.getElementById('app');
const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
let toastT;
function toast(msg) { const t = document.getElementById('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 4000); }
function irPara(a) { aba = a; editando = null; ls.set(K.aba, a); render(); window.scrollTo(0, 0); }

function render() {
  document.getElementById('hoje-data').textContent = new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
  document.querySelectorAll('.abas button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.aba === aba && !editando)));
  const pend = pendente() && dados.itens.length > 0;
  document.getElementById('pendente').hidden = !pend;
  if (editando) return renderEditor();
  ({ hoje: renderHoje, itens: renderItens, ajustes: renderAjustes }[aba] || renderHoje)();
}

function renderHoje() {
  const hoje = hojeISO(), plano = planoDoDia(hoje), marcas = (ls.get(K.marcas, {})[hoje]) || {};
  const agora = new Date(), min = agora.getHours() * 60 + agora.getMinutes();
  const toMin = h => { const [a, b] = h.split(':').map(Number); return a * 60 + b; };
  const prox = plano.find(s => !marcas[s.hora] && toMin(s.hora) >= min - 60);
  const feitos = plano.filter(s => marcas[s.hora]).length;
  const alertas = alertasEstoque();
  let h = '<header style="display:grid;gap:10px"><h1>Remédios de hoje</h1>';
  if (plano.length) h += '<div class="meter"><div class="meter-row"><span>Horários concluídos</span><span>' + feitos + ' / ' + plano.length + '</span></div><div class="bar"><i style="width:' + (feitos / plano.length * 100) + '%"></i></div></div>';
  h += '</header>';
  if (alertas.length) h += '<section>' + alertas.map(a => '<div class="alerta' + (a.faltam <= 0 ? ' danger' : '') + '"><b>' + esc(a.item.nome) + (a.faltam <= 0 ? ' acabou' : ' acaba em ' + a.faltam + (a.faltam === 1 ? ' dia' : ' dias')) + '</b><span class="note">' + (a.faltam <= 0 ? 'Atualize o estoque depois de comprar.' : 'Previsão: ' + brLongo(a.fim) + ' · restam cerca de ' + Math.max(0, a.resto) + ' doses.') + '</span></div>').join('') + '</section>';
  if (!dados.itens.length) {
    h += '<div class="box vazio">Nenhum remédio cadastrado.<br><br><button class="btn" data-acao="novo">Adicionar o primeiro</button> <button class="btn ghost" data-ir="ajustes">Conectar ao GitHub</button></div>';
  } else if (!plano.length) {
    const amanha = planoDoDia(soma(hoje, 1));
    h += '<div class="box vazio">Nada programado para hoje.</div>';
    if (amanha.length) h += '<section><h2>Amanhã</h2><div class="box">' + amanha.map(s => '<div class="slot" style="grid-template-columns:58px 1fr"><div class="time">' + s.hora + '</div><div class="items">' +
      s.itens.map(({ item, h }) => '<span class="pill">' + esc(item.nome) + (Number(h.qtd) !== 1 ? ' ×' + esc(h.qtd) : '') + '</span>').join('') + '</div></div>').join('') + '</div></section>';
  } else {
    h += '<div class="box" role="list">' + plano.map(s => {
      const tk = !!marcas[s.hora];
      return '<div class="slot' + (tk ? ' taken' : '') + (s === prox ? ' next' : '') + '" role="listitem"><div class="time">' + s.hora + '</div>' +
        '<div class="items">' + s.itens.map(({ item, h }) => '<span class="pill">' + esc(item.nome) + (Number(h.qtd) !== 1 ? ' ×' + esc(h.qtd) : '') + '</span>').join('') + '</div>' +
        '<button class="check" data-marcar="' + s.hora + '" aria-pressed="' + tk + '" aria-label="' + (tk ? 'Desmarcar ' : 'Marcar como tomado ') + s.hora + '">' + CHECK + '</button></div>';
    }).join('') + '</div>';
  }
  // Fim de prazos próximos
  const fins = [];
  dados.itens.forEach(item => item.ativo !== false && item.horarios.forEach(hh => { if (hh.fim && hh.fim >= hoje && dif(hoje, hh.fim) <= 14) fins.push(item.nome + ' às ' + hh.hora + ' até ' + br(hh.fim)); }));
  if (fins.length) h += '<section><h2>Prazos terminando</h2><p class="note">' + fins.map(esc).join('<br>') + '</p></section>';
  $app.innerHTML = h;
}

function renderItens() {
  const hoje = hojeISO();
  let h = '<header style="display:grid;gap:6px"><h1>Remédios e suplementos</h1><p class="note">Toque em um item para mudar nome, dose, horários, prazo e estoque. Depois toque em Confirmar para atualizar o Calendário.</p></header>';
  if (dados.itens.length) h += '<div class="box lista">' + dados.itens.map(item => {
    const p = previsao(item);
    const hs = item.horarios.filter(x => !x.fim || x.fim >= hoje).map(x => x.hora + (x.fim ? ' (até ' + br(x.fim) + ')' : '') + (x.inicio && x.inicio > hoje ? ' (de ' + br(x.inicio) + ')' : '')).sort();
    const est = p ? (p.fim ? Math.max(0, p.resto) + ' doses · acaba ' + br(p.fim) : Math.max(0, p.resto) + ' doses') : 'sem estoque';
    return '<button class="linha' + (item.ativo === false ? ' inativo' : '') + '" data-editar="' + item.id + '"><span class="nome">' + esc(item.nome || 'Sem nome') + '</span><span class="estq">' + esc(est) + '</span><span class="sub">' + esc(item.dose || '') + (hs.length ? ' · ' + esc(hs.join(', ')) : ' · sem horários ativos') + '</span></button>';
  }).join('') + '</div>';
  h += '<div class="linha-acoes"><button class="btn" data-acao="novo">Adicionar remédio ou suplemento</button></div>';
  $app.innerHTML = h;
}

function renderEditor() {
  const it = editando, novo = !dados.itens.some(x => x.id === it.id);
  const e = it.estoque || {};
  let h = '<header style="display:grid;gap:6px"><span class="eyebrow">' + (novo ? 'Novo item' : 'Editar item') + '</span><h1>' + esc(it.nome || 'Remédio ou suplemento') + '</h1></header>';
  h += '<form class="form" id="f-item" autocomplete="off">';
  h += '<label class="campo" for="f-nome">Nome<input type="text" id="f-nome" data-c="nome" value="' + esc(it.nome) + '" placeholder="Ex.: Ômega-3" required></label>';
  h += '<label class="campo" for="f-dose">O que é 1 dose<input type="text" id="f-dose" data-c="dose" value="' + esc(it.dose) + '" placeholder="Ex.: 2 cápsulas, 1 medida (5 g)"></label>';
  h += '<label class="campo" for="f-obs">Observação<textarea id="f-obs" data-c="obs" placeholder="Ex.: com o almoço">' + esc(it.obs) + '</textarea></label>';
  h += '<label class="toggle" for="f-ativo"><input type="checkbox" id="f-ativo" data-c="ativo"' + (it.ativo !== false ? ' checked' : '') + '> Lembretes ligados</label>';

  h += '<section><h2>Horários</h2><p class="note">Cada horário pode ter seu próprio prazo. Deixe "até" vazio para não ter fim.</p>';
  it.horarios.forEach((x, i) => {
    h += '<div class="hor"><div class="hor-top">' +
      '<label class="campo" for="h-hora-' + i + '">Hora<input type="time" id="h-hora-' + i + '" data-h="' + i + '" data-k="hora" value="' + esc(x.hora) + '"></label>' +
      '<label class="campo" for="h-qtd-' + i + '">Doses<input type="number" inputmode="decimal" min="0" step="0.5" id="h-qtd-' + i + '" data-h="' + i + '" data-k="qtd" value="' + esc(x.qtd) + '"></label>' +
      '<button type="button" class="x" data-rmh="' + i + '" aria-label="Remover horário">×</button></div>' +
      '<div class="campos-2"><label class="campo" for="h-ini-' + i + '">De<input type="date" id="h-ini-' + i + '" data-h="' + i + '" data-k="inicio" value="' + esc(x.inicio || '') + '"></label>' +
      '<label class="campo" for="h-fim-' + i + '">Até<input type="date" id="h-fim-' + i + '" data-h="' + i + '" data-k="fim" value="' + esc(x.fim || '') + '"></label></div></div>';
  });
  h += '<div class="linha-acoes"><button type="button" class="btn ghost small" data-acao="addh">+ Adicionar horário</button>' +
    (it.horarios.length > 1 ? '<button type="button" class="btn ghost small" data-acao="prazo-todos">Usar o prazo do 1º em todos</button>' : '') + '</div></section>';

  h += '<section><h2>Estoque</h2><p class="note">Quantas doses você tem agora. O app desconta pelos horários e avisa ' + dados.antecedencia + ' dias antes de acabar. Deixe vazio para não controlar.</p>' +
    '<div class="campos-2"><label class="campo" for="f-doses">Doses em estoque<input type="number" inputmode="decimal" min="0" step="0.5" id="f-doses" data-e="doses" value="' + esc(e.doses == null ? '' : e.doses) + '"></label>' +
    '<label class="campo" for="f-em">Contadas em<input type="date" id="f-em" data-e="em" value="' + esc(e.em || hojeISO()) + '"></label></div>';
  const p = previsao(it);
  if (p) h += '<p class="note">' + (p.fim ? 'Hoje restam cerca de ' + Math.max(0, p.resto) + ' doses. Acaba em ' + brLongo(p.fim) + '; aviso em ' + brLongo(soma(p.fim, -dados.antecedencia)) + '.' : 'Com os prazos atuais, o estoque não acaba.') + '</p>';
  h += '</section>';

  h += '<div class="linha-acoes"><button class="btn" type="submit">Salvar</button><button type="button" class="btn ghost" data-acao="cancelar">Cancelar</button>' +
    (novo ? '' : '<button type="button" class="btn danger" data-acao="excluir">Excluir</button>') + '</div>';
  h += '<p class="note" id="conf-excluir" hidden>Excluir ' + esc(it.nome) + ' e todos os horários? <button type="button" class="btn danger small" data-acao="excluir-sim">Sim, excluir</button></p>';
  h += '</form>';
  $app.innerHTML = h;
}

function renderAjustes() {
  const tk = token();
  let h = '<header><h1>Ajustes</h1></header>';
  h += '<section><h2>Avisos de estoque</h2><div class="campos-2">' +
    '<label class="campo" for="a-ant">Avisar quantos dias antes<input type="number" min="1" max="60" id="a-ant" data-aj="antecedencia" value="' + esc(dados.antecedencia) + '"></label>' +
    '<label class="campo" for="a-hora">Horário do aviso<input type="time" id="a-hora" data-aj="horaAvisoEstoque" value="' + esc(dados.horaAvisoEstoque) + '"></label></div></section>';

  h += '<section><h2>Conexão com o GitHub</h2>';
  if (tk) h += '<p class="note">Conectado' + (gistInfo ? ' ao Gist ' + esc(gistInfo.id.slice(0, 7)) + '…' : '; o Gist é criado no primeiro Confirmar') + '.</p>' +
    '<div class="linha-acoes"><button class="btn ghost small" data-acao="baixar">Recarregar do GitHub</button><button class="btn ghost small" data-acao="sair">Desconectar este aparelho</button></div>';
  else h += '<p class="note">Os dados ficam num Gist secreto da sua conta. Crie um token com permissão <b>gist</b> e cole aqui. Ele fica guardado só neste aparelho.</p>' +
    '<p><a href="https://github.com/settings/tokens/new?scopes=gist&description=Porta-comprimidos" target="_blank" rel="noopener">Criar token no GitHub</a> (marque "No expiration" ou um prazo longo)</p>' +
    '<form class="form" id="f-token"><label class="campo" for="a-token">Token<input type="password" id="a-token" autocomplete="off" placeholder="ghp_…" required></label><div class="linha-acoes"><button class="btn" type="submit">Conectar</button></div></form>';
  h += '</section>';

  const link = linkAssinatura();
  h += '<section><h2>Alarmes no iPhone</h2>';
  if (link) h += '<p class="note">Faça isto uma vez. Depois, cada Confirmar atualiza os alarmes sozinho.</p><ol class="passos">' +
    '<li>Toque em <a href="' + esc(link) + '">Assinar calendário</a>. Se não abrir, copie o link abaixo e vá em Ajustes do iPhone → Apps → Calendário → Contas de Calendário → Adicionar Conta → Outra → Adicionar Calendário Assinado.</li>' +
    '<li>Na tela da assinatura, <b>desligue "Remover Alertas"</b>. Sem isso os avisos não tocam.</li>' +
    '<li>Em Ajustes → Notificações → Calendário, deixe as notificações ligadas.</li>' +
    '<li>Se você importou o arquivo Suplementos.ics antes, apague aqueles eventos para não receber avisos em dobro.</li></ol>' +
    '<div class="cod" id="link-ics">' + esc(link) + '</div><div class="linha-acoes"><button class="btn ghost small" data-acao="copiar">Copiar link</button></div>' +
    '<p class="note">O iPhone busca o calendário de tempos em tempos. Para forçar, abra o app Calendário, toque em Calendários e puxe a lista para baixo.</p>';
  else h += '<p class="note">O link aparece aqui depois do primeiro Confirmar.</p>';
  h += '</section>';
  h += '<section><h2>Sobre</h2><p class="note">As marcações de "tomado" ficam só neste aparelho. Instale pelo Safari: Compartilhar → Adicionar à Tela de Início.</p></section>';
  $app.innerHTML = h;
}

/* ---------- eventos ---------- */
document.querySelector('.abas').addEventListener('click', e => { const b = e.target.closest('[data-aba]'); if (b) irPara(b.dataset.aba); });
document.getElementById('btn-confirmar').addEventListener('click', confirmar);
document.getElementById('btn-descartar').addEventListener('click', () => {
  if (!base) return toast('Não há versão confirmada para voltar.');
  dados = normalizar(JSON.parse(base)); salvarLocal(); editando = null; render(); toast('Alterações desfeitas.');
});

$app.addEventListener('click', async e => {
  const t = e.target.closest('[data-marcar],[data-editar],[data-acao],[data-rmh],[data-ir]'); if (!t) return;
  if (t.dataset.ir) return irPara(t.dataset.ir);
  if (t.dataset.marcar) {
    const m = ls.get(K.marcas, {}), d = hojeISO(); m[d] = m[d] || {};
    if (m[d][t.dataset.marcar]) delete m[d][t.dataset.marcar]; else m[d][t.dataset.marcar] = Date.now();
    Object.keys(m).forEach(k => { if (dif(k, d) > 60) delete m[k]; });
    ls.set(K.marcas, m); return render();
  }
  if (t.dataset.editar) { editando = JSON.parse(JSON.stringify(dados.itens.find(x => x.id === t.dataset.editar))); render(); return window.scrollTo(0, 0); }
  if (t.dataset.rmh != null) { editando.horarios.splice(Number(t.dataset.rmh), 1); return render(); }
  const a = t.dataset.acao;
  if (a === 'novo') { aba = 'itens'; editando = { id: novoId(), nome: '', dose: '', obs: '', ativo: true, estoque: null, horarios: [{ id: novoId(), hora: '08:00', qtd: 1, inicio: hojeISO(), fim: '' }] }; render(); window.scrollTo(0, 0); }
  else if (a === 'addh') { const u = editando.horarios[editando.horarios.length - 1]; editando.horarios.push({ id: novoId(), hora: '12:00', qtd: 1, inicio: u ? u.inicio : hojeISO(), fim: u ? u.fim : '' }); render(); }
  else if (a === 'prazo-todos') { const p = editando.horarios[0]; editando.horarios.forEach(x => { x.inicio = p.inicio; x.fim = p.fim; }); render(); }
  else if (a === 'cancelar') { editando = null; render(); }
  else if (a === 'excluir') { document.getElementById('conf-excluir').hidden = false; }
  else if (a === 'excluir-sim') { dados.itens = dados.itens.filter(x => x.id !== editando.id); salvarLocal(); editando = null; render(); toast('Excluído. Toque em Confirmar para atualizar o Calendário.'); }
  else if (a === 'baixar') { try { toast((await baixarDoGist()) ? 'Dados recarregados do GitHub.' : 'Nenhum Gist encontrado ainda.'); } catch (err) { toast(err.message); } render(); }
  else if (a === 'sair') { ls.del(K.token); ls.del(K.gist); gistInfo = null; render(); toast('Este aparelho foi desconectado.'); }
  else if (a === 'copiar') {
    const link = linkAssinatura();
    try { await navigator.clipboard.writeText(link); toast('Link copiado.'); }
    catch (err) { const r = document.createRange(); r.selectNodeContents(document.getElementById('link-ics')); const s = getSelection(); s.removeAllRanges(); s.addRange(r); toast('Selecionei o link: toque em Copiar.'); }
  }
});

$app.addEventListener('input', e => {
  const el = e.target;
  if (editando) {
    if (el.dataset.c) editando[el.dataset.c] = el.type === 'checkbox' ? el.checked : el.value;
    if (el.dataset.h != null) editando.horarios[Number(el.dataset.h)][el.dataset.k] = el.dataset.k === 'qtd' ? (el.value === '' ? '' : Number(el.value)) : el.value;
    if (el.dataset.e) { editando.estoque = editando.estoque || { doses: '', em: hojeISO() }; editando.estoque[el.dataset.e] = el.dataset.e === 'doses' ? (el.value === '' ? '' : Number(el.value)) : el.value; }
  } else if (el.dataset.aj) {
    dados[el.dataset.aj] = el.dataset.aj === 'antecedencia' ? Math.max(1, Number(el.value) || 7) : el.value;
    salvarLocal(); document.getElementById('pendente').hidden = !(pendente() && dados.itens.length);
  }
});
$app.addEventListener('change', e => { if (editando && e.target.dataset.c === 'ativo') editando.ativo = e.target.checked; });

$app.addEventListener('submit', async e => {
  e.preventDefault();
  if (e.target.id === 'f-item') {
    const it = editando;
    it.nome = (it.nome || '').trim();
    if (!it.nome) return toast('Dê um nome ao item.');
    it.horarios = it.horarios.filter(x => x.hora).map(x => Object.assign(x, { qtd: x.qtd === '' ? 1 : x.qtd, fim: x.fim || '' }));
    const ruim = it.horarios.find(x => x.inicio && x.fim && x.fim < x.inicio);
    if (ruim) return toast('No horário das ' + ruim.hora + ', a data "até" vem antes de "de".');
    if (it.estoque && (it.estoque.doses === '' || it.estoque.doses == null)) it.estoque = null;
    const i = dados.itens.findIndex(x => x.id === it.id);
    if (i >= 0) dados.itens[i] = it; else dados.itens.push(it);
    salvarLocal(); editando = null; render(); window.scrollTo(0, 0);
    toast('Salvo. Toque em Confirmar para atualizar o Calendário.');
  } else if (e.target.id === 'f-token') {
    const v = document.getElementById('a-token').value.trim(); if (!v) return;
    ls.set(K.token, v);
    try {
      const achou = await baixarDoGist();
      toast(achou ? 'Conectado. Seus remédios foram carregados.' : 'Conectado. O Gist será criado no primeiro Confirmar.');
    } catch (err) { ls.del(K.token); toast(err.message); }
    render();
  }
});

/* ---------- início ---------- */
render();
setInterval(() => { if (aba === 'hoje' && !editando) render(); }, 60000);
if (token() && (!pendente() || !dados.itens.length)) baixarDoGist().then(ok => ok && render()).catch(() => {});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
