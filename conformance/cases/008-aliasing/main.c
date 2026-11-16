#include <stdio.h>
#include <stdlib.h>

int main(void) {
    int *first = malloc(sizeof(int));
    int *second = first;
    *second = 4;
    printf("%d\n", *first);
    free(first);
    return 0;
}
