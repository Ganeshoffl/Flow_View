def divide(a, b):
    return a / b

try:
    result = divide(1, 0)
except ZeroDivisionError:
    result = None
print(result)
