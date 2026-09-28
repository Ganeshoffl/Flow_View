const items = [10, 20];
items.push(30);
const lookup = {};
lookup['a'] = 1;
const grid = [[1, 2], [3, 4]];
grid[0][1] = 9;
console.log(items[2], lookup['a'], grid[0][1]);
