#include <iostream>

int main() {
    int *first = new int;
    int *second = first;
    *second = 4;
    std::cout << *first << '\n';
    delete first;
    return 0;
}
