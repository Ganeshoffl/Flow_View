#include <iostream>

struct Node {
    int value;
    Node *next;
    explicit Node(int n) : value(n), next(nullptr) {}
    ~Node() { value = -1; }
};

int main() {
    Node *a = new Node(1);
    Node *b = new Node(2);
    Node *c = new Node(3);
    a->next = b;
    b->next = c;
    std::cout << a->next->next->value << '\n';
    delete c;
    delete b;
    delete a;
    return 0;
}
