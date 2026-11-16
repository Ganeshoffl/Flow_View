#include <stdio.h>

int main(void) {
    char name[24];
    int age;
    printf("Name: ");
    scanf("%23s", name);
    printf("Age: ");
    scanf("%d", &age);
    printf("%s %d\n", name, age);
    return 0;
}
