#include <stdio.h>

int main(void) {
    int found = 0;
    for (int i = 0; i < 10; i++) {
        if (i == 2) {
            found = 15;
            break;
        }
    }
    printf("%d\n", found);
    return 0;
}
