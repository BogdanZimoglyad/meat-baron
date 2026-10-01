/* Старі перевірки збирають результати в список [назва, пройшло?] —
   тут кожен рядок стає окремим тестом vitest із тією самою назвою. */
module.exports = t => {
  if (!t.length) throw new Error('жодної перевірки не зібрано');
  for (const [name, good] of t) test(name, () => expect(!!good, name).toBe(true));
};
