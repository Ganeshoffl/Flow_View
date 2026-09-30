public class Main {
    public static void main(String[] args) {
        int[] values = {4, 8, 15, 16, 23};
        int found = -1;
        for (int i = 0; i < values.length; i++) {
            if (values[i] > 10) {
                found = values[i];
                break;
            }
        }
        System.out.println(found);
    }
}
