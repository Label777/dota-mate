/* Dota Mate: поведение мобильной версии.
   Кнопка помощника уезжает вниз, пока вы листаете страницу вниз, и возвращается при прокрутке вверх,
   чтобы не закрывать текст. Только на узких экранах. */
(function () {
  'use strict';
  const mq = window.matchMedia ? window.matchMedia('(max-width:759px)') : { matches: false };
  let last = window.scrollY, ticking = false;
  function update() {
    ticking = false;
    const y = window.scrollY, d = y - last;
    if (!mq.matches || y < 80) document.body.classList.remove('fab-away');
    else if (d > 12) document.body.classList.add('fab-away');
    else if (d < -6) document.body.classList.remove('fab-away');
    if (Math.abs(d) > 6) last = y;
  }
  window.addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
})();
