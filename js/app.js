import { sleep, byId, shuffle, normalizeStr, setEquals, isMultiSelect, getExpectedIds, labelForMode } from './modules/utils.js';
import { saveHistory, getErrorCount, incError, decError, getThemeErrorTotal, loadErrorBank } from './modules/storage.js';
import { startTimer, clearTimer } from './modules/timer.js';
import { renderThemes, renderQuestion, renderHistory } from './modules/render.js';

/* ----------- State ----------- */
const state = {
  index: null,
  themes: [],
  currentTheme: null,
  mode: 'practice', // practice | mcq_only | exam | error_review
  examCfg: { questionCount: 20, timeLimitSec: 1200, passingPercent: 70 },
  errorCfg: { maxPerSession: 15, decayOnCorrect: 1 },
  timerHandle: null,
  questions: [],
  qIndex: 0,
  score: 0,
  answers: [],
  locked: false
};

/* ----------- Elements ----------- */
const els = {
  views: {
    themes: byId('view-themes'),
    quiz: byId('view-quiz'),
    results: byId('view-results'),
    history: byId('view-history')
  },
  themesList: byId('themes-list'),
  appTitle: byId('app-title'),
  quizTitle: byId('quiz-title'),
  quizThemeTitle: byId('quiz-theme-title'),
  quizProgress: byId('quiz-progress'),
  questionContainer: byId('question-container'),
  btnSubmit: byId('btn-submit'),
  btnNext: byId('btn-next'),
  btnQuit: byId('btn-quit'),
  resultsSummary: byId('results-summary'),
  resultsDetails: byId('results-details'),
  btnRetry: byId('btn-retry'),
  btnBackThemes: byId('btn-back-themes'),
  btnHome: byId('btn-home'),
  btnHistory: byId('btn-history'),
  historyList: byId('history-list')
};

/* ---------- Navigation ---------- */
function showView(name){
  Object.entries(els.views).forEach(([k,sec])=>{
    const active = (k===name);
    sec.hidden = !active;
    sec.classList.toggle('active', active);
  });
}

/* ---------- Timer badge (Exam) ---------- */
function ensureTimerElement(){
  let el = document.getElementById('quiz-timer');
  if(!el){
    el = document.createElement('span');
    el.id = 'quiz-timer';
    el.style.marginLeft = '8px';
    el.className = 'badge';
    els.quizProgress.parentElement?.appendChild(el);
  }
  return el;
}

/* ---------- Quiz Engine ---------- */
async function startTheme(themeId, mode='practice'){
  const themeMeta = state.themes.find(t=>t.id===themeId);
  if(!themeMeta) return alert('Thème introuvable.');
  state.mode = mode;

  try{
    applyAppDefaultsFromIndex();

    const res = await fetch(themeMeta.file);
    const theme = await res.json();
    state.currentTheme = theme;

    let questions = theme.questions.slice();

    // QCM-only = mcq & true_false
    if(mode === 'mcq_only'){
      questions = questions.filter(q=> q.type==='mcq' || q.type==='true_false');
      if(questions.length === 0){ alert('Aucune question QCM/VF trouvée dans ce thème.'); return; }
    }

    // Révision d’erreurs : lot priorisé
    if(mode === 'error_review'){
      const lot = buildErrorReviewLot(theme, state.errorCfg.maxPerSession);
      if(lot.length === 0){ alert('Aucune question à revoir pour ce thème.'); return; }
      questions = lot;
    }

    // Shuffle
    if(theme.settings?.shuffleQuestions) questions = shuffle(questions);

    // Examen: sous-ensemble
    if(mode === 'exam' && questions.length > state.examCfg.questionCount){
      questions = shuffle(questions).slice(0, state.examCfg.questionCount);
    }

    // Shuffle choices
    questions = questions.map(q=>{
      if(q.type==='mcq' && theme.settings?.shuffleChoices && Array.isArray(q.choices)){
        return {...q, choices: shuffle(q.choices)};
      }
      return q;
    });

    // init run
    state.questions = questions;
    state.qIndex = 0;
    state.score = 0;
    state.answers = [];
    state.locked = false;
    els.quizThemeTitle.textContent = theme.title;
    els.quizTitle.textContent = labelForMode(mode, theme.title);
    showView('quiz');

    // Timer (exam)
    if(mode === 'exam'){
      const timerEl = ensureTimerElement();
      state.timerHandle = startTimer(
        state.examCfg.timeLimitSec,
        (remain)=>{ timerEl.textContent = `⏱ ${Math.floor(remain/60)}:${String(remain%60).padStart(2,'0')}`; },
        ()=>{ showResults(true); }
      );
    } else {
      const timerEl = document.getElementById('quiz-timer');
      if(timerEl) timerEl.textContent = '';
      clearTimer(state.timerHandle);
      state.timerHandle = null;
    }

    renderQuestion(state, els);
  }catch(e){
    console.error(e);
    alert('Impossible de charger le thème.');
  }
}

function getUserAnswer(){
  const form = document.getElementById('form-q');
  if(!form) return null;
  const q = state.questions[state.qIndex];
  if(q?.type === 'mcq' && isMultiSelect(q)){
    return Array.from(form.querySelectorAll('input[name="answer"]:checked')).map(el=>el.value);
  }
  const data = new FormData(form);
  return data.get('answer');
}
function normalize(s){ return normalizeStr(s); }

function checkAnswer(){
  if(state.locked) return;
  const q = state.questions[state.qIndex];
  let user = getUserAnswer();

  if(user===null || user===undefined || user==='' || (Array.isArray(user) && user.length===0)){
    alert('Veuillez sélectionner/entrer une réponse.');
    return;
  }

  let correct = false;
  let expected = q.answer;

  if(q.type==='mcq'){
    const expectedIds = getExpectedIds(q).map(String);
    if(Array.isArray(user)){
      const setUser = new Set(user.map(String));
      const setExp  = new Set(expectedIds);
      correct = setEquals(setUser, setExp);
    } else {
      correct = (String(user) === String(expectedIds[0]));
    }
  }
  else if(q.type==='true_false'){
    const truth = (q.answer===true) ? 'true' : 'false';
    correct = (user === truth);
  }
  else if(q.type==='fill_in'){
    const accepted = Array.isArray(q.answer) ? q.answer : [q.answer];
    correct = accepted.some(acc => normalize(acc) === normalize(user));
  }

  if(correct){ state.score += 1; }
  state.answers.push({qid:q.id, userAnswer:user, correct, expected});

  // Banque d’erreurs
  if(correct){
    if(getErrorCount(state.currentTheme.id, q.id) > 0){
      decError(state.currentTheme.id, q.id, state.errorCfg.decayOnCorrect);
    }
  } else {
    incError(state.currentTheme.id, q.id);
  }

  // lock UI
  state.locked = true;
  els.btnSubmit.disabled = true;
  els.btnNext.disabled = false;

  // feedback (pas en exam)
  if(state.mode !== 'exam'){
    const feedback = byId('feedback');
    if(feedback){
      const cls = correct ? 'correct' : 'incorrect';
      const label = correct ? 'Correct ✅' : 'Incorrect ❌';
      const rationale = q.rationale ? `<div class="muted">${q.rationale}</div>` : '';
      feedback.className = `feedback ${cls}`;
      feedback.innerHTML = `<strong>${label}</strong>${rationale}`;
    }
  }
}

function nextQuestion(){
  if(!state.locked) return;
  state.qIndex += 1;
  if(state.qIndex >= state.questions.length){
    return showResults(false);
  }
  renderQuestion(state, els);
}

function quitQuiz(){
  if(state.mode==='exam'){
    if(!confirm('Quitter l’examen en cours ? Le temps sera arrêté.')) return;
  }
  clearTimer(state.timerHandle);
  state.timerHandle = null;
  showView('themes');
  renderThemes(state, els, startTheme);
}

function showResults(timeout=false){
  clearTimer(state.timerHandle);
  state.timerHandle = null;

  const total = state.questions.length;
  const scorePct = Math.round((state.score/total)*100);
  let header = `Score: ${state.score} / ${total} (${scorePct}%)`;

  let passed = null;
  if(state.mode === 'exam'){
    passed = (scorePct >= state.examCfg.passingPercent);
    header += ` • ${passed ? 'Réussi ✅' : 'Échoué ❌'}`;
    if(timeout){ header += ' • Temps écoulé ⏱'; }
  }

  els.resultsSummary.textContent = header;
  els.resultsDetails.innerHTML = '';

  state.questions.forEach((q, idx)=>{
    const ans = state.answers[idx] || {};
    const card = document.createElement('article');
    card.className = 'card';

    const choiceLabel = (id)=>{
      const found = (q.choices||[]).find(c=>String(c.id)===String(id));
      return found ? found.label : id;
    };

    const expectedIds = (q.type==='mcq') ? getExpectedIds(q) :
                        (q.type==='true_false') ? [q.answer ? 'Vrai':'Faux'] :
                        Array.isArray(q.answer) ? q.answer : [q.answer];

    const expectedLabel = (()=>{
      if(q.type==='mcq')      return expectedIds.map(choiceLabel).join(', ');
      if(q.type==='true_false') return q.answer ? 'Vrai' : 'Faux';
      const arr = Array.isArray(q.answer)? q.answer : [q.answer];
      return arr.join(' / ');
    })();

    const userLabel = (()=>{
      if(q.type==='mcq'){
        if(Array.isArray(ans.userAnswer)) return ans.userAnswer.map(choiceLabel).join(', ');
        else return choiceLabel(ans.userAnswer);
      } else if(q.type==='true_false'){
        return ans.userAnswer==='true' ? 'Vrai' : 'Faux';
      } else return ans.userAnswer || '—';
    })();

    card.innerHTML = `
      <div><strong>Q${idx+1}. ${q.prompt}</strong></div>
      <div class="${ans.correct?'correct':'incorrect'}">Votre réponse : ${userLabel || '—'}</div>
      <div>Bonne réponse : <strong>${expectedLabel}</strong></div>
      ${q.rationale ? `<div class="muted">${q.rationale}</div>` : ''}
    `;
    els.resultsDetails.appendChild(card);
  });

  const entry = {
    themeId: state.currentTheme.id,
    themeTitle: state.currentTheme.title,
    mode: state.mode,
    total,
    score: state.score,
    percent: scorePct,
    at: new Date().toISOString()
  };
  if(state.mode==='exam'){
    entry.exam = {
      passingPercent: state.examCfg.passingPercent,
      passed,
      timeLimitSec: state.examCfg.timeLimitSec
    };
  }
  saveHistory(entry);

  showView('results');
  renderHistory(state, els);
}

/* ---------- Defaults depuis l’index ---------- */
function applyAppDefaultsFromIndex(){
  const app = state.index?.app || {};
  if(app.examDefaults){
    state.examCfg = {
      questionCount: Number(app.examDefaults.questionCount) || state.examCfg.questionCount,
      timeLimitSec:  Number(app.examDefaults.timeLimitSec)  || state.examCfg.timeLimitSec,
      passingPercent:Number(app.examDefaults.passingPercent)|| state.examCfg.passingPercent
    };
  }
  if(app.errorReview){
    state.errorCfg = {
      maxPerSession: Number(app.errorReview.maxPerSession) || state.errorCfg.maxPerSession,
      decayOnCorrect:Number(app.errorReview.decayOnCorrect)|| state.errorCfg.decayOnCorrect
    };
  }
}
function buildErrorReviewLot(theme, maxCount){
  const bank = loadErrorBank()[theme.id] || {};
  const withCounts = theme.questions
    .map(q=>({ q, count: bank[q.id] || 0 }))
    .filter(x=>x.count>0)
    .sort((a,b)=> b.count - a.count);
  return withCounts.slice(0, maxCount).map(x=>x.q);
}

/* ---------- Bootstrap ---------- */
async function loadIndex(){
  try{
    const res = await fetch('data/theme-main.json');
    const index = await res.json();
    state.index = index;
    state.themes = index.themes || [];
    els.appTitle.textContent = index.app?.title || 'Ergo Quiz';
    applyAppDefaultsFromIndex();
    renderThemes(state, els, startTheme);
  }catch(e){
    console.error(e);
    alert('Impossible de charger le catalogue de thèmes.');
  }
}
function bindEvents(){
  els.btnSubmit.addEventListener('click', checkAnswer);
  els.btnNext.addEventListener('click', nextQuestion);
  els.btnQuit.addEventListener('click', quitQuiz);
  els.btnRetry.addEventListener('click', ()=> startTheme(state.currentTheme?.id, state.mode));
  els.btnBackThemes.addEventListener('click', ()=> { clearTimer(state.timerHandle); state.timerHandle=null; showView('themes'); renderThemes(state, els, startTheme); });
  els.btnHome.addEventListener('click',       ()=> { clearTimer(state.timerHandle); state.timerHandle=null; showView('themes'); renderThemes(state, els, startTheme); });
  els.btnHistory.addEventListener('click',    ()=> { renderHistory(state, els); showView('history'); });
}
document.addEventListener('DOMContentLoaded', async ()=>{
  bindEvents();
  await loadIndex();
  renderHistory(state, els);
});