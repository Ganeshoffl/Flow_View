#include <stdio.h>

int main(void) {
    int total = 0;
    int i = 0;
    for (; i < 500; i++) {
        total += i;
    }
    i -= 1;
    printf("%d\n", total);
    return 0;
}
