#include <stdio.h>
#include <stdlib.h>

struct Node { int value; struct Node *next; };

int main(void) {
    struct Node *a = calloc(1, sizeof(struct Node));
    struct Node *b = calloc(1, sizeof(struct Node));
    struct Node *c = calloc(1, sizeof(struct Node));
    a->next = b;
    b->next = c;
    c->value = 3;
    printf("%d\n", a->next->next->value);
    return 0;
}
