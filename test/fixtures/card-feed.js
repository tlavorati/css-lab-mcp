document.addEventListener('click', function (e) {
  var toggle = e.target.closest('.menu-toggle');
  document.querySelectorAll('.menu.open').forEach(function (m) {
    if (!toggle || m !== toggle.nextElementSibling) m.classList.remove('open');
  });
  if (toggle) toggle.nextElementSibling.classList.toggle('open');
  var item = e.target.closest('.menu-item');
  if (item) document.getElementById('log').textContent = 'clicked: ' + item.textContent;
});
