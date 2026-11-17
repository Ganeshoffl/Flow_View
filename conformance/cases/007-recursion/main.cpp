#include <stdio.h>

int fact(int n) {
    if (n < 2) return 1;
    return n * fact(n - 1);
}

int main(void) {
    int answer = fact(4);
    printf("%d\n", answer);
    return 0;
}
