#include <stdio.h>
#include <stdlib.h>

struct Entry { int key; int value; };

int main(void) {
    int **nested = calloc(2, sizeof(int *));
    int *numbers = calloc(3, sizeof(int));
    int *inner = calloc(1, sizeof(int));
    struct Entry *map = calloc(1, sizeof(struct Entry));
    struct Entry *other = calloc(1, sizeof(struct Entry));
    nested[0] = numbers;
    nested[1] = inner;
    numbers[2] = 30;
    inner[0] = 9;
    map->key = 7;
    map->value = 1;
    other->key = 8;
    printf("%d %d %d\n", nested[0][2], map->value, nested[1][0]);
    return 0;
}
