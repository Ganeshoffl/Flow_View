class Node {
  constructor(value) {
    this.value = value;
    this.next = null;
  }
}

const head = new Node(1);
head.next = new Node(2);
head.next.next = new Node(3);
console.log(head.next.next.value);
