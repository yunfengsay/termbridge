(() => {
  'use strict';
  const demo = globalThis.VoiceLearningDemo;
  const history = [demo.initial()];
  const current = () => history[history.length - 1];
  const personalScore = document.getElementById('personal-score');
  const fill = document.getElementById('personal-fill');
  const status = document.getElementById('demo-status');
  const negative = document.getElementById('negative');
  const positive = document.getElementById('positive');
  const undo = document.getElementById('undo');

  function render(message) {
    const state = current();
    const probability = demo.score(state);
    personalScore.replaceChildren(document.createTextNode((probability * 100).toFixed(1)));
    const percent = document.createElement('span');
    percent.textContent = '%';
    personalScore.append(percent);
    fill.style.transform = `scaleX(${probability})`;
    undo.disabled = history.length === 1;
    negative.disabled = positive.disabled = state.steps >= demo.maxSteps;
    status.textContent = message;
  }

  function correct(label) {
    const next = demo.update(current(), label);
    if (next === current()) return;
    history.push(next);
    const description = label === 0 ? '不是对助手说' : '这句是在叫它';
    render(`演示版本 ${next.steps} · 已用“${description}”小步更新。${next.steps === demo.maxSteps ? '达到演示上限，可撤销或重置。' : '仅改变合成样本分数，不证明真实意图识别变准。'}`);
  }

  negative.addEventListener('click', () => correct(0));
  positive.addEventListener('click', () => correct(1));
  undo.addEventListener('click', () => {
    if (history.length > 1) history.pop();
    render(`已撤销一次演示更新，回到版本 ${current().steps}。所有状态只在本页面内存中。`);
  });
  document.getElementById('reset').addEventListener('click', () => {
    history.splice(0, history.length, demo.initial());
    render('已清除所有演示调整。没有保存录音、样本或个人信息。');
  });
  document.getElementById('print').addEventListener('click', () => window.print());

  // No microphone, network requests, analytics, storage, or scroll polling.
  if ('IntersectionObserver' in window) {
    const links = [...document.querySelectorAll('.rail nav a')];
    const chapters = [...document.querySelectorAll('.chapter[id]')];
    const activeSections = new Set();
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) activeSections.add(entry.target.id);
        else activeSections.delete(entry.target.id);
      }
      const active = chapters.find(chapter => activeSections.has(chapter.id))?.id;
      if (!active) return;
      for (const link of links) {
        if (link.hash === `#${active}`) link.setAttribute('aria-current', 'location');
        else link.removeAttribute('aria-current');
      }
    }, { rootMargin: '-10% 0px -55% 0px' });
    chapters.forEach(chapter => observer.observe(chapter));

    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const reveal = new IntersectionObserver(entries => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add('is-visible');
          reveal.unobserve(entry.target);
        }
      }, { rootMargin: '0px 0px 60px 0px' });
      document.querySelectorAll('.diagram-figure, .demo, .settings').forEach(element => {
        if (element.getBoundingClientRect().top <= window.innerHeight) return;
        element.classList.add('reveal-ready');
        reveal.observe(element);
      });
    }
  }
})();
