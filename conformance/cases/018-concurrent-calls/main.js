function later(value) {
  return new Promise((resolve) => setTimeout(() => resolve(value), 10));
}

async function work(n) {
  const first = await later(n);
  const second = await later(n * 2);
  return first + second;
}

async function main() {
  const both = await Promise.all([work(1), work(100)]);
  console.log(both[0] + ' ' + both[1]);
}

main();
