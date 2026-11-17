#include <stdio.h>

int add(int a, int b) {
    return a + b;
}

int main(void) {
    int total = add(3, 4);
    printf("%d\n", total);
    return 0;
}
