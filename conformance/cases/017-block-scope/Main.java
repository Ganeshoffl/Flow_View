public class Main {
    public static void main(String[] args) {
        int x = 1;
        if (x > 0) {
            int y = 2;
            x = x + y;
        }
        for (int i = 0; i < 2; i++) {
            int doubled = i * 2;
            x = x + doubled;
        }
        x = 5;
        System.out.println(x);
    }
}
