#include <stdio.h>

int main(void) {
    int x = 3;
    if (x > 0) {
        int y = 2;
        x += y;
    }
    printf("%d\n", x);
    return 0;
}
