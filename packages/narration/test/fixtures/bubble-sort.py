values = [5, 1, 4, 2]
n = len(values)
for i in range(n - 1):
    for j in range(n - 1 - i):
        if values[j] > values[j + 1]:
            values[j], values[j + 1] = values[j + 1], values[j]
print(values)
