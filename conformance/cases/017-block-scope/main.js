let x = 1;
if (x > 0) {
  let y = 2;
  x = x + y;
}
for (let i = 0; i < 2; i++) {
  const doubled = i * 2;
  x = x + doubled;
}
x = 5;
console.log(x);
