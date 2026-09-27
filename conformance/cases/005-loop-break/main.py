values = [4, 8, 15, 16, 23]
found = -1
for i in range(len(values)):
    if values[i] > 10:
        found = values[i]
        break
print(found)
