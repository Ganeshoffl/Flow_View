function divide(a, b) {
  if (b === 0) {
    throw new RangeError('division by zero');
  }
  return a / b;
}

let result;
try {
  result = divide(1, 0);
} catch (err) {
  result = null;
}

function later() {
  return 42;
}

const check = later();
console.log(result, check);
