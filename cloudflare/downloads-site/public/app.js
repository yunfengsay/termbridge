const status = document.querySelector('#copy-status');
let statusTimer;
for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', async () => {
    clearTimeout(statusTimer);
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
      status.textContent = '已复制，可以粘贴到 Terminal。';
    } catch {
      status.textContent = '无法自动复制，请选择旁边的命令手动复制。';
      const code = button.parentElement.querySelector('code');
      if (code) {
        const range = document.createRange(); range.selectNodeContents(code);
        const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      }
    }
    status.classList.add('visible');
    statusTimer = setTimeout(() => status.classList.remove('visible'), 4000);
  });
}
function revealDetail() {
  const detail = document.getElementById(location.hash.slice(1));
  if (detail?.tagName === 'DETAILS') detail.open = true;
}
window.addEventListener('hashchange', revealDetail);
revealDetail();
