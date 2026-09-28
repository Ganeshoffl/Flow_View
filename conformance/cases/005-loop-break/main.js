const values = [4, 8, 15, 16, 23];
let found = -1;
for (let i = 0; i < values.length; i++) {
  if (values[i] > 10) {
    found = values[i];
    break;
  }
}
console.log(found);
