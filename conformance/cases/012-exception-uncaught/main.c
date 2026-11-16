#include <stdlib.h>

int main(void) {
    int *valid = malloc(sizeof(int));
    *valid = 1;
    int *bad = 0;
    *bad = 42;
    return 0;
}
